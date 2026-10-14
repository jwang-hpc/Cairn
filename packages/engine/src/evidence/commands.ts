// `re evidence parse <EXP> [--job <id>]`: run the registered parsers over an experiment's committed raw evidence.
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import { LedgerError } from "../ledger/ledger.js";
import { parseEvidence, type ParserRunner, SandboxParserRunner } from "./parse.js";

export const EVIDENCE_COMMANDS = ["evidence"] as const;
export const EVIDENCE_OPTIONS = { job: { type: "string" } } as const;
export const EVIDENCE_USAGE = `evidence commands:
  evidence parse <EXP-NNN> [--job <id>]   run the parsers (packages/engine/parsers, in the agent image) over the
                                          experiment's raw evidence; tables go to evidence/tables/<EXP>/<job>/`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

export async function runEvidenceCommand(engine: Engine, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv, runner?: ParserRunner): Promise<number> {
  const [sub, experiment] = args;
  if (sub !== "parse" || !experiment) {
    io.err(`re evidence: usage\n${EVIDENCE_USAGE}`);
    return 2;
  }
  try {
    const ledger = await openCurrentProject(engine, v, env);
    io.err(`re evidence: parsing ${experiment} in ${ledger.name} (parsers run in the agent image)`);
    const done = await parseEvidence(ledger, { experiment, ...(typeof v.job === "string" ? { job: v.job } : {}) }, runner ?? new SandboxParserRunner({ image: engine.config.engine.agent?.image ?? "cairn-agent:dev" }));
    if (done.length === 0) io.out("(nothing to parse: no input matches a parser)");
    for (const j of done) {
      io.out(`job ${j.job}`);
      for (const i of j.inputs) io.out(`  ${i.path} → ${i.parser}: ${i.outputs.join(", ")}${i.notes.length ? `  (${i.notes.join("; ")})` : ""}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof LedgerError) {
      io.err(`re evidence: ${e.message}`);
      return 1;
    }
    io.err(`re evidence: ${(e as Error).message}`);
    return 1;
  }
}
