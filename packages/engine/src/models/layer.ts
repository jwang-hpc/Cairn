// The engine's only path to models. pi-ai / pi-agent-core types stay inside packages/engine
// (DR-0004 seam 1). Every call: data-class check (invariant 9) -> per-route budget check -> call ->
// usage record (invariant 6). Routes are tried in config order; a route is skipped if unavailable, over
// its daily budget, or if it fails with an auth/limit/server error before producing any content.
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type CredentialStore,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type Context,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AuthKind, DataClass, EffortLevel, ModelConfig, ProviderConfig, Route, UsageEvent } from "@cairn/shared";
import { BudgetExceededError, type BudgetRun } from "../budget/governor.js";
import type { LoadedConfig } from "../config/load.js";
import { type EventLog, envelope } from "../events/log.js";
import { FileCredentialStore, storePath } from "./credentials.js";
import { classifyFailure, hasContent, nativeEffort } from "./inspect.js";

/** pi-ai collections, one per auth kind, each backed by its own credential store. */
export interface PiRuntime {
  models: Record<AuthKind, MutableModels>;
  stores: Record<AuthKind, CredentialStore>;
}

export function createPiRuntime(home: string): PiRuntime {
  const stores = {
    oauth: new FileCredentialStore(storePath(home, "oauth")),
    api_key: new FileCredentialStore(storePath(home, "api_key")),
  };
  return {
    stores,
    models: { oauth: builtinModels({ credentials: stores.oauth }), api_key: builtinModels({ credentials: stores.api_key }) },
  };
}

export interface CallSpec {
  /** models.yaml alias. */
  alias: string;
  effort: EffortLevel;
  role: string;
  /** Data class of the project the context comes from (DR-0013). */
  dataClass: DataClass;
  run: BudgetRun;
  /** Restrict to one configured route (health checks); no fallback. */
  onlyRoute?: Route;
}

export const routeLabel = (r: Route) => `${r.pi_provider}/${r.auth}`;

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isContentEvent(e: AssistantMessageEvent): boolean {
  return (
    (e.type === "text_delta" && e.delta.trim() !== "") ||
    (e.type === "thinking_delta" && e.delta.trim() !== "") ||
    e.type === "toolcall_start"
  );
}

type Attempt = { committed: AssistantMessageEventStream } | { failed: string };

export class ModelLayer {
  constructor(
    readonly config: LoadedConfig,
    readonly pi: PiRuntime,
    readonly log: EventLog,
  ) {}

  /** Look up an alias; throws with the known aliases if it doesn't exist. */
  resolve(alias: string): { model: ModelConfig; provider: ProviderConfig } {
    const model = this.config.models.models[alias];
    if (!model) {
      throw new Error(`unknown model alias '${alias}' (known: ${Object.keys(this.config.models.models).join(", ")})`);
    }
    return { model, provider: this.config.models.providers[model.provider]! };
  }

  /** A pi-agent-core StreamFn bound to one call spec. The `model` the agent passes is ignored. */
  streamFn(spec: CallSpec): StreamFn {
    this.resolve(spec.alias); // fail fast on unknown aliases
    return (_model, context, options) => this.stream(spec, context, options);
  }

  async stream(spec: CallSpec, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
    const { model: m, provider } = this.resolve(spec.alias);
    const vendor = m.provider;

    if (!provider.data_classes.includes(spec.dataClass)) {
      const reason = `refused: provider '${vendor}' may not receive '${spec.dataClass}' data (models.yaml providers.${vendor}.data_classes: ${provider.data_classes.join(", ") || "none"})`;
      await this.log.append({
        ...envelope(spec.run.runId, this.config.engine.machine),
        type: "approval",
        subject: `send ${spec.dataClass} context to ${vendor} (${spec.alias})`,
        decision: "denied",
        by: "policy",
        reason,
      });
      return errorStream(vendor, m.id, reason);
    }

    const failures: string[] = [];
    const only = spec.onlyRoute;
    const routes = only ? provider.routes.filter((r) => r.pi_provider === only.pi_provider && r.auth === only.auth) : provider.routes;
    if (routes.length === 0) return errorStream(vendor, m.id, `route ${only ? routeLabel(only) : "(none)"} is not configured for ${vendor}`);
    for (const route of routes) {
      const label = routeLabel(route);
      const model = this.pi.models[route.auth].getModel(route.pi_provider, m.id);
      if (!model) {
        failures.push(`${label}: pi-ai has no model '${m.id}' for provider '${route.pi_provider}'`);
        continue;
      }
      const unavailable = await this.routeProblem(route);
      if (unavailable) {
        failures.push(`${label}: ${unavailable}`);
        continue;
      }
      try {
        await spec.run.check(vendor, route.auth);
      } catch (e) {
        if (e instanceof BudgetExceededError && e.scope === "daily") {
          failures.push(`${label}: ${e.message}`);
          continue;
        }
        if (e instanceof BudgetExceededError) return errorStream(vendor, m.id, e.message);
        throw e;
      }
      const mapped = this.config.models.effort_map[vendor]![spec.effort];
      // pi-ai disables reasoning by omitting the option; it has no "off" value.
      const level = mapped === "off" ? undefined : mapped;
      const attempt = await this.#attempt(spec, vendor, route, model, level, context, options);
      if ("committed" in attempt) return attempt.committed;
      failures.push(`${label}: ${attempt.failed}`);
    }
    return errorStream(vendor, m.id, `no route for ${spec.alias} succeeded:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }

  /** Why a route can't be used right now, or undefined if it can. */
  async routeProblem(route: Route): Promise<string | undefined> {
    if (this.pi.models[route.auth].getModels(route.pi_provider).length === 0) {
      return `pi-ai has no provider '${route.pi_provider}' (check models.yaml routes)`;
    }
    const stored = await this.pi.stores[route.auth].read(route.pi_provider);
    if (route.auth === "oauth" && stored?.type !== "oauth") {
      return `not logged in (run: re login ${route.pi_provider} oauth)`;
    }
    if (route.auth === "api_key" && stored !== undefined && stored.type !== "api_key") {
      return "stored credential is not an API key";
    }
    try {
      const auth = await this.pi.models[route.auth].getAuth(route.pi_provider);
      if (!auth) return `no API key (run: re login ${route.pi_provider} api_key)`;
    } catch (e) {
      return `auth failed: ${(e as Error).message}`;
    }
    return undefined;
  }

  async #attempt(
    spec: CallSpec,
    vendor: string,
    route: Route,
    model: Model<Api>,
    level: SimpleStreamOptions["reasoning"],
    context: Context,
    options: SimpleStreamOptions | undefined,
  ): Promise<Attempt> {
    let native: Record<string, unknown> = {};
    const started = Date.now();
    const { reasoning: _agentLevel, ...rest } = options ?? {};
    const src = this.pi.models[route.auth].streamSimple(model, context, {
      ...rest,
      ...(level === undefined ? {} : { reasoning: level }),
      onPayload: (payload) => {
        native = nativeEffort(payload);
        return undefined;
      },
    });
    const record = (msg: AssistantMessage) =>
      spec.run.record(this.#usage(spec, vendor, route, model.id, native, msg, Date.now() - started));

    const it = src[Symbol.asyncIterator]();
    const buffered: AssistantMessageEvent[] = [];
    for (;;) {
      const next = await it.next();
      if (next.done) return { committed: replay(buffered) };
      const e = next.value;
      if (e.type === "error") {
        await record(e.error);
        const cls = classifyFailure(e.error.errorMessage);
        if (!hasContent(e.error) && cls !== "other" && e.reason !== "aborted") {
          return { failed: `${cls} failure: ${e.error.errorMessage ?? "unknown error"}` };
        }
        return { committed: replay([...buffered, e]) };
      }
      if (e.type === "done") {
        await record(e.message);
        return { committed: replay([...buffered, e]) };
      }
      buffered.push(e);
      if (isContentEvent(e)) return { committed: forward(buffered, it, record) };
    }
  }

  #usage(spec: CallSpec, vendor: string, route: Route, modelId: string, native: Record<string, unknown>, msg: AssistantMessage, durationMs: number): UsageEvent {
    const u = msg.usage ?? ZERO_USAGE;
    return {
      ...envelope(spec.run.runId, this.config.engine.machine),
      type: "usage",
      provider: vendor,
      route: route.pi_provider,
      auth: route.auth,
      model: modelId,
      alias: spec.alias,
      role: spec.role,
      effort: spec.effort,
      nativeEffort: native,
      tokens: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 },
      cost: { usd: Math.max(0, u.cost?.total ?? 0), kind: route.auth === "api_key" ? "billed" : "notional" },
      durationMs: Math.max(0, Math.round(msg.durationMs ?? durationMs)),
      stopReason: msg.stopReason,
      error: msg.errorMessage ?? null,
    };
  }
}

function replay(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  for (const e of events) out.push(e);
  out.end();
  return out;
}

/** Forward a committed stream; the final message is recorded before the agent sees it complete. */
function forward(
  buffered: AssistantMessageEvent[],
  it: AsyncIterator<AssistantMessageEvent>,
  record: (m: AssistantMessage) => Promise<void>,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  for (const e of buffered) out.push(e);
  void (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      const e = next.value;
      if (e.type === "done" || e.type === "error") {
        const final = e.type === "done" ? e.message : e.error;
        try {
          await record(final);
        } catch (err) {
          // Invariant 6: an unrecorded call must not look like a success.
          const failed: AssistantMessage = { ...final, stopReason: "error", errorMessage: `usage not recorded: ${(err as Error).message}` };
          out.push({ type: "error", reason: "error", error: failed });
          break;
        }
      }
      out.push(e);
    }
    out.end();
  })();
  return out;
}

function errorStream(provider: string, modelId: string, message: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const error = {
    role: "assistant",
    content: [],
    api: "unknown",
    provider,
    model: modelId,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  out.push({ type: "error", reason: "error", error });
  out.end();
  return out;
}
