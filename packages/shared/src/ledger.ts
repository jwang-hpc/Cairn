// ARA ledger formats (DR-0007; schemas follow the vendored ARA research-manager skill, ara@e52a925).
import Type from "typebox";
import { EffortLevel } from "./events.js";

/**
 * Provenance tags. ARA's four tags, extended by DR-0007 with model and effort for AI-originated entries:
 * user | user-revised | ai-suggested(<model>, <effort>) | ai-executed(<model>, <effort>)
 */
export const PROVENANCE_PATTERN = "^(user|user-revised|ai-suggested\\([A-Za-z0-9._:/-]+, (low|medium|high|max)\\)|ai-executed\\([A-Za-z0-9._:/-]+, (low|medium|high|max)\\))$";
export const Provenance = Type.String({ pattern: PROVENANCE_PATTERN });
export type Provenance = string;

export const provenance = {
  user: "user" as Provenance,
  userRevised: "user-revised" as Provenance,
  aiSuggested: (model: string, effort: EffortLevel) => `ai-suggested(${model}, ${effort})` as Provenance,
  aiExecuted: (model: string, effort: EffortLevel) => `ai-executed(${model}, ${effort})` as Provenance,
};
export const isProvenance = (s: unknown): s is Provenance => typeof s === "string" && new RegExp(PROVENANCE_PATTERN).test(s);
/** Human-originated provenance (commits under the user's identity; may pass human gates). */
export const isHumanProvenance = (p: Provenance) => p === "user" || p === "user-revised";

export const NODE_TYPES = ["question", "decision", "experiment", "dead_end", "pivot"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Required type-specific fields (ARA event taxonomy). */
export const NODE_REQUIRED: Record<NodeType, readonly string[]> = {
  question: ["description"],
  decision: ["choice", "alternatives", "evidence"],
  experiment: ["result", "evidence"],
  dead_end: ["hypothesis", "failure_mode", "lesson"],
  pivot: ["from", "to", "trigger"],
};

const Str = Type.String({ minLength: 1 });
const StrList = Type.Array(Type.String());

/** One exploration-tree node (trace/exploration_tree.yaml). `children` are validated recursively by the ledger. */
export const ExplorationNode = Type.Object(
  {
    id: Type.String({ pattern: "^N\\d{2,}$" }),
    type: Type.Union([Type.Literal("question"), Type.Literal("decision"), Type.Literal("experiment"), Type.Literal("dead_end"), Type.Literal("pivot")]),
    title: Str,
    provenance: Provenance,
    timestamp: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }),
    description: Type.Optional(Type.String()),
    choice: Type.Optional(Type.String()),
    alternatives: Type.Optional(StrList),
    evidence: Type.Optional(Type.Union([StrList, Type.String()])),
    result: Type.Optional(Type.String()),
    hypothesis: Type.Optional(Type.String()),
    failure_mode: Type.Optional(Type.String()),
    lesson: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    trigger: Type.Optional(Type.String()),
    status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("unresolved")])),
    also_depends_on: Type.Optional(Type.Array(Type.String({ pattern: "^N\\d{2,}$" }))),
    parent: Type.Optional(Type.String({ pattern: "^N\\d{2,}$" })),
    children: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ExplorationNode = Omit<Type.Static<typeof ExplorationNode>, "children"> & { children?: ExplorationNode[] };

/** Research hypothesis (logic/hypotheses.md; DR-0007 fields, recorded before experiments). */
export const HYPOTHESIS_STATUSES = ["proposed", "approved", "testing", "supported", "refuted", "killed", "withdrawn"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
export const HypothesisInput = Type.Object(
  {
    title: Str,
    statement: Str,
    prediction: Str,
    falsification: Str,
    baseline: Str,
    decisive_experiment: Str,
    kill_criteria: Str,
  },
  { additionalProperties: false },
);
export type HypothesisInput = Type.Static<typeof HypothesisInput>;
export interface Hypothesis extends HypothesisInput {
  id: string;
  status: HypothesisStatus;
  provenance: Provenance;
  /** Exploration node that opened it, and the date. */
  opened: string;
}

/** One line of engine/ledger.jsonl: every ledger write, tagged. */
export const LedgerWrite = Type.Object(
  {
    ts: Type.String(),
    op: Str,
    file: Str,
    id: Type.Optional(Type.String()),
    provenance: Provenance,
    summary: Type.String(),
    commit: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type LedgerWrite = Type.Static<typeof LedgerWrite>;
