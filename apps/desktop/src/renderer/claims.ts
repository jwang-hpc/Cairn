// Claim gate logic for the app, free of React (DR-0007). Nothing reaches logic/claims.md without passing the gate:
// 1. support check (code only), 2. rigor review (a model; advice), 3. the user's approval, which re-checks support
// and needs a review of this exact draft. A draft an agent committed always enters as user-revised.
import type { Draft } from "./api.js";

export interface GateState {
  /** Step a draft is at, for the list. */
  stage: "approved" | "reviewed" | "not reviewed";
  canCheck: boolean;
  canReview: boolean;
  /** Approval needs a review of this exact draft on file. */
  canApprove: boolean;
  label: string;
}

export function gateState(d: Draft): GateState {
  if (d.approved) return { stage: "approved", canCheck: false, canReview: false, canApprove: false, label: `approved as ${d.approved.claim}` };
  if (d.review) return { stage: "reviewed", canCheck: true, canReview: true, canApprove: true, label: `reviewed: ${d.review.verdict}` };
  return { stage: "not reviewed", canCheck: true, canReview: true, canApprove: false, label: "not reviewed" };
}

/** Drafts waiting for the user first, then reviewed ones, then approved; by title within each. */
export function sortDrafts(drafts: readonly Draft[]): Draft[] {
  const rank = { "not reviewed": 1, reviewed: 0, approved: 2 } as const;
  return [...drafts].sort((a, b) => rank[gateState(a).stage] - rank[gateState(b).stage] || a.title.localeCompare(b.title) || a.ref.localeCompare(b.ref));
}
