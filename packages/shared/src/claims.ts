// Claim drafts and the support report of the claim gate (DR-0007). A draft is one ARA claim block; the report is
// what the code-only support check found, shown to the user (CLI now, app in M8) before any approval.

export const CLAIM_STATUSES = ["hypothesis", "untested", "testing", "supported", "weakened", "refuted", "withdrawn"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** ARA claim fields, in the order they are written to logic/claims.md. */
export const CLAIM_FIELDS = ["Statement", "Conditions", "Sources", "Status", "Provenance", "Falsification", "Proof", "Dependencies", "Tags"] as const;
/** Fields the gate requires before it checks anything. */
export const CLAIM_REQUIRED = ["Statement", "Conditions", "Sources", "Status", "Falsification", "Proof"] as const;

/**
 * One Sources entry: `<value> ← <file:line | trace-node:field> «verbatim line» [input|result]`, or
 * `<value> ← [pending: reason]` (ARA research-manager, "Number grounding").
 */
export interface SourceEntry {
  raw: string;
  value: string;
  ref?: { kind: "file"; path: string; line: number } | { kind: "node"; node: string; field: string };
  quote?: string;
  tag?: "input" | "result";
  pending?: string;
}

export interface ClaimDraft {
  title: string;
  fields: Record<string, string>;
  sources: SourceEntry[];
  /** Problems with the draft's form (missing fields, unparseable source lines). */
  problems: string[];
}

export type SourceCheck = "ok" | "rounded" | "failed" | "pending";
export type CoverageCheck = "exact" | "rounded" | "uncovered";

export interface SupportReport {
  ok: boolean;
  title: string;
  /** Ledger commit the sources were read at. */
  revision: string;
  checkedAt: string;
  sources: { entry: string; value: string; status: SourceCheck; detail: string }[];
  coverage: { field: string; number: string; status: CoverageCheck; source?: string }[];
  errors: string[];
  warnings: string[];
  /** What the check did and did not establish (support is not correctness). */
  checked: string[];
  notChecked: string[];
}
