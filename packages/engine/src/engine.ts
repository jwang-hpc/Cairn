// Engine facade: the API the CLI (and later the app) uses. No pi types cross this boundary
// (DR-0004 seam 1); results are plain data built from the normalized event log.
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthKind, EffortLevel, Route, UsageEvent } from "@cairn/shared";
import { BudgetGovernor, type DailyTotals } from "./budget/governor.js";
import { type LoadedConfig, loadConfig } from "./config/load.js";
import { EventLog, envelope, readUsage } from "./events/log.js";
import { deviceId } from "./models/credentials.js";
import { type CallSpec, ModelLayer, type PiRuntime, createPiRuntime, routeLabel } from "./models/layer.js";
import type { EnginePaths } from "./paths.js";

export interface AskOptions {
  /** models.yaml alias; defaults to routing.triage.worker. */
  alias?: string;
  effort?: EffortLevel;
  role?: string;
  /** Receives streamed answer text. */
  onText?: (delta: string) => void;
  /** Restrict to one route (health checks). */
  onlyRoute?: Route;
}

export interface AskResult {
  run: string;
  text: string;
  ok: boolean;
  error: string | null;
  usage: UsageEvent[];
}

export interface RouteStatus {
  route: string;
  auth: AuthKind;
  problem: string | null;
}

export interface Status {
  machine: string;
  paths: EnginePaths;
  providers: { name: string; dataClasses: string[]; routes: RouteStatus[] }[];
  today: DailyTotals;
  caps: LoadedConfig["engine"]["budget"];
}

/** Interaction callbacks for `login` (kept pi-free: plain strings in and out). */
export interface LoginIo {
  show(message: string): void;
  ask(message: string, secret: boolean): Promise<string>;
  choose(message: string, options: { id: string; label: string }[]): Promise<string>;
}

const ASK_SYSTEM_PROMPT = "You are a concise research assistant.";

export class Engine {
  readonly log: EventLog;
  readonly governor: BudgetGovernor;
  readonly layer: ModelLayer;

  constructor(
    readonly config: LoadedConfig,
    readonly paths: EnginePaths,
    readonly pi: PiRuntime,
  ) {
    this.log = new EventLog(paths.home);
    this.governor = new BudgetGovernor(config.engine.budget, this.log);
    this.layer = new ModelLayer(config, pi, this.log);
  }

  static async open(paths: EnginePaths): Promise<Engine> {
    return new Engine(await loadConfig(paths.configDir), paths, createPiRuntime(paths.home));
  }

  defaultAlias(): string {
    const alias = this.config.models.routing.triage?.worker?.split("@")[0];
    if (!alias) throw new Error("no default model: set routing.triage.worker in models.yaml or pass --model");
    return alias;
  }

  /**
   * A pi Model object for an alias. pi-agent-core needs one in its state; the layer's streamFn still picks
   * the real route per call. Internal to the engine (seam 1).
   */
  piModelFor(alias: string): Model<Api> {
    const { model: m, provider } = this.layer.resolve(alias);
    const piModel = provider.routes.map((r) => this.pi.models[r.auth].getModel(r.pi_provider, m.id)).find((x) => x !== undefined);
    if (!piModel) throw new Error(`pi-ai knows no route for ${alias} (${m.id}); check models.yaml routes`);
    return piModel;
  }

  /** One-shot agent call (M1 acceptance): every model call goes through the governor and is recorded. */
  async ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    const alias = opts.alias ?? this.defaultAlias();
    const role = opts.role ?? "triage";
    const runId = randomUUID();
    const piModel = this.piModelFor(alias);

    const run = await this.governor.startRun(role, runId);
    const spec: CallSpec = {
      alias,
      effort: opts.effort ?? "low",
      role,
      dataClass: this.config.models.projects_default_data_class,
      run,
      ...(opts.onlyRoute ? { onlyRoute: opts.onlyRoute } : {}),
    };
    const streamFn = this.layer.streamFn(spec);
    const machine = this.config.engine.machine;

    await this.log.append({ ...envelope(runId, machine), type: "message", role: "user", text: prompt });
    const agent = new Agent({ initialState: { systemPrompt: ASK_SYSTEM_PROMPT, model: piModel }, streamFn });
    agent.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        opts.onText?.(e.assistantMessageEvent.delta);
      }
    });
    await agent.prompt(prompt);

    const last = agent.state.messages.at(-1);
    const final = last && last.role === "assistant" ? last : undefined;
    const text = final?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") ?? "";
    const error = final?.stopReason === "error" || final?.stopReason === "aborted" ? (final.errorMessage ?? final.stopReason) : null;
    if (text !== "") await this.log.append({ ...envelope(runId, machine), type: "message", role: "assistant", text });
    const usage = (await readUsage(this.paths.home)).records.filter((u) => u.run === runId);
    return { run: runId, text, ok: error === null && text !== "", error, usage };
  }

  async status(): Promise<Status> {
    const providers = await Promise.all(
      Object.entries(this.config.models.providers).map(async ([name, p]) => ({
        name,
        dataClasses: p.data_classes,
        routes: await Promise.all(
          p.routes.map(async (r) => ({ route: routeLabel(r), auth: r.auth, problem: (await this.layer.routeProblem(r)) ?? null })),
        ),
      })),
    );
    return { machine: this.config.engine.machine, paths: this.paths, providers, today: await this.governor.today(true), caps: this.config.engine.budget };
  }

  /** Cheapest configured alias for a vendor, by pi-ai catalog list price (health checks). */
  #cheapestAlias(vendor: string): string | undefined {
    const route = this.config.models.providers[vendor]?.routes[0];
    const price = ([, m]: [string, { id: string }]) => {
      const c = route ? this.pi.models[route.auth].getModel(route.pi_provider, m.id)?.cost : undefined;
      return c ? c.input + c.output : Number.POSITIVE_INFINITY;
    };
    return Object.entries(this.config.models.models)
      .filter(([, m]) => m.provider === vendor)
      .sort((a, b) => price(a) - price(b))[0]?.[0];
  }

  /**
   * Health check: a one-word call on every usable route, with the vendor's cheapest model. Routes that
   * aren't set up (no login/key, unknown provider) are reported as skipped, not failed.
   */
  async check(): Promise<{ provider: string; route: string; result: "ok" | "failed" | "skipped"; detail: string }[]> {
    const results: { provider: string; route: string; result: "ok" | "failed" | "skipped"; detail: string }[] = [];
    for (const [vendor, p] of Object.entries(this.config.models.providers)) {
      const alias = this.#cheapestAlias(vendor);
      for (const route of p.routes) {
        const label = routeLabel(route);
        const problem = await this.layer.routeProblem(route);
        if (problem || !alias) {
          results.push({ provider: vendor, route: label, result: "skipped", detail: problem ?? "no model configured" });
          continue;
        }
        const r = await this.ask("Reply with exactly one word: ok", { alias, effort: "low", role: "triage", onlyRoute: route });
        const u = r.usage.at(-1);
        results.push({
          provider: vendor,
          route: label,
          result: r.ok ? "ok" : "failed",
          detail: r.ok ? `${u?.model} replied "${r.text.trim().slice(0, 20)}" (${u?.tokens.input ?? 0}/${u?.tokens.output ?? 0} tokens)` : (r.error ?? "no answer"),
        });
      }
    }
    return results;
  }

  /** Interactive login for one pi provider route; credentials go to the engine home (host only). */
  async login(piProvider: string, kind: AuthKind, io: LoginIo): Promise<string> {
    const id = await deviceId(this.paths.home);
    const cred = await this.pi.models[kind].login(
      piProvider,
      kind,
      {
        prompt: async (p) => {
          if (p.type === "select") return io.choose(p.message, p.options.map((o) => ({ id: o.id, label: o.label })));
          return io.ask(p.message, p.type === "secret");
        },
        notify: (e) => {
          if (e.type === "auth_url") io.show(`Open this URL in your browser:\n${e.url}${e.instructions ? `\n${e.instructions}` : ""}`);
          else if (e.type === "device_code") io.show(`Enter code ${e.userCode} at ${e.verificationUri}`);
          else if (e.type === "info") io.show([e.message, ...(e.links ?? []).map((l) => l.url)].join("\n"));
          else io.show(e.message);
        },
      },
      { agentName: "cairn", getDeviceId: () => id },
    );
    return cred.type === "oauth" ? `logged in to ${piProvider} (subscription)` : `stored API key for ${piProvider}`;
  }
}
