// Claim drafts waiting for the gate (M8.3): every staging/claims/*.md committed on a branch of the project (an analysis
// agent's branch, usually), with where it stands: reviewed (the verdict on file for this exact draft) and approved
// (the claim the gate made from it). Read from git, as the gate reads drafts; nothing here writes.
import { git } from "@cairn/launcher";
import type { Ledger } from "../ledger/ledger.js";
import { BRANCH_DRAFT } from "./commands.js";
import { parseDraft } from "./draft.js";
import { type ClaimReview, draftSha, renderReview } from "./review.js";

export interface DraftListing {
  /** <branch>:staging/claims/<name>.md: what check, review, and approve take. */
  ref: string;
  branch: string;
  title: string;
  sha256: string;
  md: string;
  review?: { verdict: ClaimReview["verdict"]; summary: string; reviewer: string; at: string; text: string };
  approved?: { claim: string; at: string; by: string };
}

const MAX_BRANCHES = 200;
const MAX_DRAFTS = 300;
const MAX_DRAFT_BYTES = 64 << 10;

const show = (dir: string, spec: string) => git(dir, ["show", spec]).then((s) => s, () => undefined);

export async function listDrafts(ledger: Ledger): Promise<DraftListing[]> {
  // What the gate has on file, by draft hash: reviews and approvals at HEAD.
  const onFile = (await git(ledger.dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", "engine/claims/"]).catch(() => "")).split("\n").filter(Boolean);
  const approvals = new Map<string, NonNullable<DraftListing["approved"]>>();
  for (const p of onFile.filter((f) => /^engine\/claims\/C\d+\/gate\.json$/.test(f))) {
    try {
      const g = JSON.parse((await show(ledger.dir, `HEAD:${p}`)) ?? "") as { claim: string; draft_sha256: string; approved: { by: string; at: string } };
      approvals.set(g.draft_sha256, { claim: g.claim, at: g.approved.at, by: g.approved.by });
    } catch {
      // a malformed record is the ledger check's business, not this listing's
    }
  }
  const reviewed = new Set(onFile.filter((f) => /^engine\/claims\/reviews\/[0-9a-f]{16}\.json$/.test(f)).map((f) => f.slice(-21, -5)));

  const branches = (await git(ledger.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean).slice(0, MAX_BRANCHES);
  const out: DraftListing[] = [];
  for (const branch of branches) {
    const paths = (await git(ledger.dir, ["ls-tree", "--name-only", branch, "--", "staging/claims/"]).catch(() => "")).split("\n").filter((p) => p.endsWith(".md"));
    for (const path of paths) {
      const ref = `${branch}:${path}`;
      if (!BRANCH_DRAFT.test(ref) || out.length >= MAX_DRAFTS) continue;
      const md = await show(ledger.dir, ref);
      if (md === undefined || Buffer.byteLength(md) > MAX_DRAFT_BYTES) continue;
      const sha256 = draftSha(md);
      let review: DraftListing["review"];
      if (reviewed.has(sha256.slice(0, 16))) {
        try {
          const r = JSON.parse((await show(ledger.dir, `HEAD:engine/claims/reviews/${sha256.slice(0, 16)}.json`)) ?? "") as ClaimReview;
          if (r.draft_sha256 === sha256) review = { verdict: r.verdict, summary: r.summary, reviewer: `${r.reviewer.alias} (${r.reviewer.model}, ${r.reviewer.effort})`, at: r.at, text: renderReview(r) };
        } catch {
          // unreadable review: listed as not reviewed
        }
      }
      const approved = approvals.get(sha256);
      out.push({ ref, branch, title: parseDraft(md).title || "(no claim heading)", sha256, md, ...(review ? { review } : {}), ...(approved ? { approved } : {}) });
    }
  }
  return out;
}
