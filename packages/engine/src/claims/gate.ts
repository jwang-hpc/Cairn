// The claim gate end to end (DR-0007): 1. support check (code), 2. rigor review (a model, advice only),
// 3. the user's approval (Ledger.approveClaim, the only writer of logic/claims.md).
import { type EffortLevel, provenance, type SupportReport } from "@cairn/shared";
import type { Engine } from "../engine.js";
import { type Ledger, LedgerError } from "../ledger/ledger.js";
import { parseDraft } from "./draft.js";
import { ledgerReader } from "./reader.js";
import { callReviewer, type ClaimReview, draftSha, parseReview, renderReview, reviewPacket, reviewPrompt, rigorCriteria } from "./review.js";
import { checkSupport } from "./support.js";

/** The reviewer: an explicit choice, else routing.analysis.reviewer (another vendor than the analysis worker). */
export function reviewerFor(engine: Engine, opts: { alias?: string; effort?: EffortLevel }): { alias: string; effort: EffortLevel } {
  const routed = engine.config.models.routing.analysis?.reviewer;
  const alias = opts.alias ?? routed?.split("@")[0];
  if (!alias) throw new LedgerError("no reviewer: set routing.analysis.reviewer in models.yaml or pass --model");
  return { alias, effort: opts.effort ?? (routed?.split("@")[1] as EffortLevel | undefined) ?? "high" };
}

/** Steps 1 and 2: the support check must pass first; the review is committed as ai-suggested. */
export async function reviewDraft(
  engine: Engine,
  ledger: Ledger,
  md: string,
  opts: { alias?: string; effort?: EffortLevel; now?: () => Date } = {},
): Promise<{ report: SupportReport; review?: ClaimReview }> {
  const now = opts.now ?? (() => new Date());
  const draft = parseDraft(md);
  const reader = ledgerReader(ledger);
  const report = await checkSupport(draft, reader, now());
  if (!report.ok) return { report };
  const who = reviewerFor(engine, opts);
  const criteria = await rigorCriteria();
  const prompt = reviewPrompt(criteria.text, await reviewPacket(ledger, reader, md, draft, report));
  const answer = await callReviewer(engine, ledger, who, prompt);
  const sha = draftSha(md);
  const review: ClaimReview = { draft_sha256: sha, reviewer: { ...who, model: answer.model }, at: now().toISOString(), run: answer.run, ...parseReview(answer.text) };
  const path = `engine/claims/reviews/${sha.slice(0, 16)}`;
  await ledger.writeArtifacts(
    [
      { path: `${path}.json`, content: `${JSON.stringify({ ...review, criteria: criteria.source }, null, 2)}\n` },
      { path: `${path}.md`, content: `# Rigor review of claim draft ${sha.slice(0, 16)}\n\n<!-- ai-suggested: advice for the user, not a decision -->\n\n${renderReview(review)}\n\n## Draft\n\n${md}` },
    ],
    provenance.aiSuggested(answer.model, who.effort),
    `rigor review of claim draft ${sha.slice(0, 16)}: ${review.verdict} (${draft.title})`,
    "claim-review",
  );
  return { report, review };
}
