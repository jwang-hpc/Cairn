// `re claim check | review | approve | list`: the claim gate (DR-0007) from the CLI. check is code only; review asks
// a reviewer model for advice; approve is the user's decision and the only way into logic/claims.md.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import { LedgerError } from "../ledger/ledger.js";
import { parseDraft } from "./draft.js";
import { ledgerReader } from "./reader.js";
import type { EffortLevel } from "@cairn/shared";
import { reviewDraft } from "./gate.js";
import { renderReview } from "./review.js";
import { checkSupport, renderReport } from "./support.js";

export const CLAIM_COMMANDS = ["claim"] as const;
export const CLAIM_OPTIONS = { json: { type: "boolean" } } as const;
export const CLAIM_USAGE = `claim commands (nothing reaches logic/claims.md without the gate):
  claim check <draft.md> [--json]    1. support check, code only: every source opened in the committed ledger,
                                        every number in the claim backed by one; exit 0 only if it passes
  claim review <draft.md> [--model A] [--effort E]
                                     2. rigor review by a model (default routing.analysis.reviewer); advice only
  claim approve <draft.md> [--note N]
                                     3. your approval: re-checks support, needs a review of this exact draft,
                                        writes the claim to logic/claims.md as C<nn>
  claim list                         claims in logic/claims.md`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

export async function runClaimCommand(engine: Engine, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, file] = args;
  if (!["check", "review", "approve", "list"].includes(sub ?? "")) {
    io.err(`re claim: unknown subcommand '${sub ?? ""}'\n${CLAIM_USAGE}`);
    return 2;
  }
  if (sub === "list") {
    try {
      const ledger = await openCurrentProject(engine, v, env);
      const claims = await ledger.claims();
      if (claims.length === 0) io.out(`(no claims in ${ledger.name} yet)`);
      for (const c of claims) io.out(`${c.id}  ${(c.fields.Status ?? "?").padEnd(10)} ${(c.fields.Provenance ?? "?").padEnd(13)} ${c.title}`);
      return 0;
    } catch (e) {
      if (e instanceof LedgerError) {
        io.err(`re claim: ${e.message}`);
        return 1;
      }
      throw e;
    }
  }
  if (!file) {
    io.err(`usage: re claim ${sub} <draft.md>`);
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
    if (sub === "check") {
      const report = await checkSupport(parseDraft(md), ledgerReader(ledger));
      io.out(v.json ? JSON.stringify(report, null, 2) : `project ${ledger.name}\n${renderReport(report)}`);
      return report.ok ? 0 : 1;
    }
    if (sub === "review") {
      io.err(`re claim: support check, then a rigor review by a model (this calls a model; project ${ledger.name} [${ledger.dataClass}])`);
      const r = await reviewDraft(engine, ledger, md, {
        ...(typeof v.model === "string" ? { alias: v.model } : {}),
        ...(typeof v.effort === "string" ? { effort: v.effort as EffortLevel } : {}),
      });
      if (!r.review) {
        io.out(renderReport(r.report));
        io.err("re claim: the support check fails; fix the draft before asking for a review");
        return 1;
      }
      io.out(`support check: PASSED (${r.report.sources.length} sources, ${r.report.coverage.length} numbers)`);
      io.out(renderReview(r.review));
      io.out(`approve with: re claim approve ${file}${r.review.verdict === "ready" ? "" : "   (the reviewer suggests revising first; your call)"}`);
      return 0;
    }
    const a = await ledger.approveClaim(md, { ...(typeof v.note === "string" ? { note: v.note } : {}) });
    io.out(`approved: ${a.id} in logic/claims.md (${a.provenance}); support re-checked at ${a.report.revision.slice(0, 12)}, review ${a.review.verdict} by ${a.review.reviewer.alias}`);
    io.out(`gate record: engine/claims/${a.id}/`);
    return 0;
  } catch (e) {
    // Gate refusals (LedgerError) and reviewer failures (provider refused, no route) are messages, not crashes.
    io.err(`re claim: ${(e as Error).message}`);
    return 1;
  }
}
