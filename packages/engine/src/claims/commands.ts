// `re claim check <draft.md>`: the code-only support check (DR-0007 step 1) of a claim draft against the current
// project's committed ledger. No model is called.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import { LedgerError } from "../ledger/ledger.js";
import { parseDraft } from "./draft.js";
import { ledgerReader } from "./reader.js";
import { checkSupport, renderReport } from "./support.js";

export const CLAIM_COMMANDS = ["claim"] as const;
export const CLAIM_OPTIONS = { json: { type: "boolean" } } as const;
export const CLAIM_USAGE = `claim commands (nothing reaches logic/claims.md without the gate):
  claim check <draft.md> [--json]    support check, code only: every source opened in the committed ledger,
                                     every number in the claim backed by one; exit 0 only if it passes`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

export async function runClaimCommand(engine: Engine, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, file] = args;
  if (sub !== "check") {
    io.err(`re claim: unknown subcommand '${sub ?? ""}'\n${CLAIM_USAGE}`);
    return 2;
  }
  if (!file) {
    io.err("usage: re claim check <draft.md> [--json]");
    return 2;
  }
  let md: string;
  try {
    md = await readFile(resolve(file), "utf8");
  } catch (e) {
    io.err(`re claim: cannot read ${file}: ${(e as Error).message}`);
    return 2;
  }
  try {
    const ledger = await openCurrentProject(engine, v, env);
    const report = await checkSupport(parseDraft(md), ledgerReader(ledger));
    io.out(v.json ? JSON.stringify(report, null, 2) : `project ${ledger.name}\n${renderReport(report)}`);
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof LedgerError) {
      io.err(`re claim: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
