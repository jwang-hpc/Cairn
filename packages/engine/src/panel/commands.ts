// `re panel run | list | show | replay | judge`
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "../engine.js";
import { readUsage } from "../events/log.js";
import { LedgerError } from "../ledger/ledger.js";
import { openCurrentProject } from "../ledger/commands.js";
import { judgePanel, type MemberRef, PanelError, parseMemberRef, readPanel, renderPanel, ROUND_MODES, type RoundMode, runPanel } from "./panel.js";

export const PANEL_OPTIONS = {
  question: { type: "string" },
  rounds: { type: "string" },
  members: { type: "string" },
  synth: { type: "string" },
  routing: { type: "string" },
  exchanges: { type: "string" },
  venue: { type: "string" },
  prefer: { type: "string" },
} as const;

export const PANEL_USAGE = `panel commands (members answer blind; outputs stay ai-suggested until you accept them):
  panel run --question Q [--hypothesis HY01] --rounds independent,critique[,synthesis]
            (--members claude-sonnet@high,gpt-frontier@high [--synth claude-opus@high] | --routing critique)
            [--exchanges N] (debate)  [--venue SC] (redteam)
            rounds: ${ROUND_MODES.join(", ")}
  panel list | panel show <id> | panel replay <id>        (blind until judged)
  panel judge <id> --prefer A[,B] [--note N]              (records your judgment, unblinds)`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}
const csv = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const fmtTok = (n: number) => n.toLocaleString("en-US");

export async function runPanelCommand(engine: Engine, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, id] = args;
  try {
    const ledger = await openCurrentProject(engine, v, env);
    switch (sub) {
      case "run": {
        const question = v.question as string | undefined;
        if (!question) throw new PanelError("--question is required");
        const rounds = csv((v.rounds as string | undefined) ?? "independent,critique") as RoundMode[];
        let members: MemberRef[];
        let synth: MemberRef | undefined;
        if (v.routing) {
          const r = engine.config.models.routing[v.routing as string];
          if (!r?.panel) throw new PanelError(`routing.${v.routing} has no panel in models.yaml`);
          members = r.panel.map(parseMemberRef);
          synth = r.synthesizer ? parseMemberRef(r.synthesizer) : undefined;
        } else {
          members = csv(v.members as string | undefined).map(parseMemberRef);
          synth = v.synth ? parseMemberRef(v.synth as string) : undefined;
        }
        if (v.synth) synth = parseMemberRef(v.synth as string);
        io.err(`re panel: ${members.length} members · rounds ${rounds.join(" → ")} · project ${ledger.name} [${ledger.dataClass}] (this calls models)`);
        const rec = await runPanel(engine, ledger, {
          question,
          rounds,
          members,
          ...(synth ? { synthesizer: synth } : {}),
          ...(v.hypothesis ? { hypothesis: v.hypothesis as string } : {}),
          ...(v.exchanges ? { exchanges: Number(v.exchanges) } : {}),
          ...(v.venue ? { venue: v.venue as string } : {}),
        });
        io.out(`panel ${rec.id}`);
        for (const r of rec.rounds) {
          io.out(`  round ${r.n} ${r.mode}: ${r.outputs.map((o) => `${o.label}${o.step ? ` ${o.step}` : ""} ${o.status}${o.error ? ` (${o.error.replace(/\n\s*-\s*/g, " | ").trim()})` : ""}`).join("; ")}`);
        }
        for (const w of rec.warnings) io.out(`  warning: ${w}`);
        const usage = (await readUsage(engine.paths.home)).records.filter((u) => u.run === rec.id);
        const tokens = usage.reduce((s, u) => s + u.tokens.input + u.tokens.output, 0);
        const billed = usage.filter((u) => u.cost.kind === "billed").reduce((s, u) => s + u.cost.usd, 0);
        io.out(`  ${usage.length} model calls · ${fmtTok(tokens)} tokens · $${billed.toFixed(4)} billed`);
        io.out(`show with: re panel show ${rec.id}`);
        const ok = rec.rounds.some((r) => r.outputs.some((o) => o.status === "ok"));
        return ok ? 0 : 1;
      }
      case "list": {
        const ids = (await readdir(join(ledger.dir, "engine", "panels")).catch(() => [] as string[])).sort();
        if (ids.length === 0) io.out("(no panels)");
        for (const pid of ids) {
          const { record } = await readPanel(ledger, pid);
          io.out(`${pid}  ${record.rounds.map((r) => r.mode).join("→").padEnd(28)} ${record.hypothesis ?? "-"}  ${record.judgment ? "judged" : "blind"}  ${record.question.slice(0, 60)}`);
        }
        return 0;
      }
      case "show":
      case "replay": {
        if (!id) throw new PanelError(`usage: re panel ${sub} <id>`);
        const { record, texts } = await readPanel(ledger, id);
        io.out(renderPanel(record, texts));
        return 0;
      }
      case "judge": {
        if (!id) throw new PanelError("usage: re panel judge <id> --prefer A[,B] [--note N]");
        const rec = await judgePanel(ledger, id, { prefer: csv(v.prefer as string | undefined), ...(v.note ? { note: v.note as string } : {}) });
        io.out(`judged ${id}; now unblinded:`);
        for (const m of rec.members) io.out(`  ${m.label} = ${m.alias} (${m.model}, ${m.provider}, ${m.effort})`);
        return 0;
      }
      default:
        io.err(`re panel: unknown subcommand '${sub ?? ""}'\n${PANEL_USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof PanelError || e instanceof LedgerError) {
      io.err(`re panel: ${e.message}`);
      return e instanceof PanelError ? 2 : 1;
    }
    throw e;
  }
}
