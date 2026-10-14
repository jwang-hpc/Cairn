// `re claim check | review | approve | list`: the claim gate (DR-0007) from the CLI. check is code only; review asks
// a reviewer model for advice; approve is the user's decision and the only way into logic/claims.md.
import { readFile } from "node:fs/promises";
import { git } from "@cairn/launcher";
import { resolve } from "node:path";
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import { type Ledger, LedgerError } from "../ledger/ledger.js";
import { parseDraft } from "./draft.js";
import { ledgerReader } from "./reader.js";
import type { EffortLevel, SupportReport } from "@cairn/shared";
import { reviewDraft } from "./gate.js";
import { renderReview } from "./review.js";
import { checkSupport, renderReport } from "./support.js";

export const CLAIM_COMMANDS = ["claim"] as const;
export const CLAIM_OPTIONS = { json: { type: "boolean" }, own: { type: "boolean" } } as const;
export const CLAIM_USAGE = `claim commands (nothing reaches logic/claims.md without the gate):
  (<draft> is a file, or <branch>:staging/claims/<name>.md, e.g. a draft an analysis agent committed)
  claim check <draft.md> [--json]    1. support check, code only: every source opened in the committed ledger,
                                        every number in the claim backed by one; exit 0 only if it passes
  claim review <draft.md> [--model A] [--effort E]
                                     2. rigor review by a model (default routing.analysis.reviewer); advice only
  claim approve <draft.md> [--note N] [--own]
                                     3. your approval: re-checks support, needs a review of this exact draft,
                                        writes the claim to logic/claims.md as C<nn> (user-revised; --own if
                                        you wrote the draft yourself: user)
  claim list                         claims in logic/claims.md`;

type Values = Record<string, string | boolean | undefined>;

/** A draft committed on a branch of the project: <branch>:staging/claims/<name>.md. */
export const BRANCH_DRAFT = /^([A-Za-z0-9][A-Za-z0-9._/-]*):(staging\/claims\/[A-Za-z0-9._-]+\.md)$/;

/** A draft committed on a branch of the project (agent/<id>:staging/claims/x.md), read from git. */
export async function readBranchDraft(ledger: Ledger, ref: string): Promise<string> {
  const m = BRANCH_DRAFT.exec(ref);
  if (!m) throw new LedgerError(`not a branch draft (want <branch>:staging/claims/<name>.md): ${ref}`);
  try {
    return await git(ledger.dir, ["show", `${m[1]}:${m[2]}`]);
  } catch {
    throw new LedgerError(`no ${m[2]} on branch ${m[1]} of ${ledger.name}`);
  }
}

/** A draft file on disk, or one committed on a branch of the project (agent/<id>:staging/claims/x.md). */
async function readDraft(ledger: Ledger, ref: string): Promise<string> {
  try {
    return await readFile(resolve(ref), "utf8");
  } catch (e) {
    if (!BRANCH_DRAFT.test(ref)) throw new LedgerError(`cannot read ${ref}: ${(e as Error).message}`);
    return readBranchDraft(ledger, ref);
  }
}

/** Step 1, code only: the support check of a draft against the ledger as committed. */
export async function checkDraft(ledger: Ledger, md: string): Promise<SupportReport> {
  return checkSupport(parseDraft(md), ledgerReader(ledger));
}

/**
 * Step 3, the user's approval. `ref` is where the draft came from: a draft committed on a branch was written by
 * someone else (an agent), so it is never the user's own, whatever `own` says.
 */
export function approveDraft(ledger: Ledger, md: string, ref: string | undefined, opts: { note?: string | undefined; own?: boolean | undefined }) {
  return ledger.approveClaim(md, { ...(typeof opts.note === "string" ? { note: opts.note } : {}), own: opts.own === true && !(ref !== undefined && BRANCH_DRAFT.test(ref)) });
}
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
  try {
    const ledger = await openCurrentProject(engine, v, env);
    const md = await readDraft(ledger, file);
    if (sub === "check") {
      const report = await checkDraft(ledger, md);
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
    const a = await approveDraft(ledger, md, file, { note: typeof v.note === "string" ? v.note : undefined, own: v.own === true });
    io.out(`approved: ${a.id} in logic/claims.md (${a.provenance}); support re-checked at ${a.report.revision.slice(0, 12)}, review ${a.review.verdict} by ${a.review.reviewer.alias}`);
    io.out(`gate record: engine/claims/${a.id}/`);
    return 0;
  } catch (e) {
    // Gate refusals (LedgerError) and reviewer failures (provider refused, no route) are messages, not crashes.
    io.err(`re claim: ${(e as Error).message}`);
    return 1;
  }
}
