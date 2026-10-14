// Normalized event log (DR-0004 seam 3). Provenance, audit, and budget consume only these records.
// One JSON object per line. Usage records double as engine/usage.jsonl lines (invariant 6).
import Type from "typebox";

/** Engine effort levels (DR-0013). Providers map them to native settings via config effort_map. */
export const EffortLevel = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("max")]);
export type EffortLevel = Type.Static<typeof EffortLevel>;
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const satisfies readonly EffortLevel[];

export const AuthKind = Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]);
export type AuthKind = Type.Static<typeof AuthKind>;

const NonEmpty = Type.String({ minLength: 1 });
const Count = Type.Integer({ minimum: 0 });
const IsoTimestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$" });

/** Fields every event carries. */
const envelope = {
  v: Type.Literal(1),
  ts: IsoTimestamp,
  id: NonEmpty,
  /** Groups events of one run (worker invocation, panel round, CLI call). */
  run: NonEmpty,
  /** Machine id from engine.yaml (DR-0010: per-machine accounting). */
  machine: NonEmpty,
  /** Engine version (DR-0012: every record carries it). */
  engine: NonEmpty,
};

export const MessageEvent = Type.Object(
  {
    ...envelope,
    type: Type.Literal("message"),
    role: Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const ToolCallEvent = Type.Object(
  { ...envelope, type: Type.Literal("tool_call"), toolCallId: NonEmpty, name: NonEmpty, args: Type.Unknown() },
  { additionalProperties: false },
);

export const ToolResultEvent = Type.Object(
  {
    ...envelope,
    type: Type.Literal("tool_result"),
    toolCallId: NonEmpty,
    name: NonEmpty,
    isError: Type.Boolean(),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const Tokens = Type.Object(
  { input: Count, output: Count, cacheRead: Count, cacheWrite: Count },
  { additionalProperties: false },
);

export const UsageEvent = Type.Object(
  {
    ...envelope,
    type: Type.Literal("usage"),
    /** Vendor key from models.yaml providers (anthropic, openai, google, microsoft, ...). */
    provider: NonEmpty,
    /** pi-ai provider that carried the call (e.g. anthropic, openai-codex, openai). */
    route: NonEmpty,
    auth: AuthKind,
    /** Native model id as sent to the provider. */
    model: NonEmpty,
    /** models.yaml alias, when the call was made through one. */
    alias: Type.Optional(NonEmpty),
    role: NonEmpty,
    effort: EffortLevel,
    /** Effort-related fields of the provider payload as actually sent (DR-0013: record native too). */
    nativeEffort: Type.Record(Type.String(), Type.Unknown()),
    tokens: Tokens,
    /**
     * Cost as computed from list prices. "billed" for API-key calls; "notional" for subscription calls,
     * which spend no money (spike finding C7).
     */
    cost: Type.Object({ usd: Type.Number({ minimum: 0 }), kind: Type.Union([Type.Literal("billed"), Type.Literal("notional")]) }, { additionalProperties: false }),
    durationMs: Count,
    stopReason: NonEmpty,
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ApprovalEvent = Type.Object(
  {
    ...envelope,
    type: Type.Literal("approval"),
    /** What is being approved, e.g. "jobs.submit EXP-003 on uncc-hpc". */
    subject: NonEmpty,
    decision: Type.Union([Type.Literal("requested"), Type.Literal("approved"), Type.Literal("denied")]),
    by: Type.Union([Type.Literal("user"), Type.Literal("policy")]),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One decision of an agent's egress proxy (DR-0005: every network attempt is logged). */
export const EgressEvent = Type.Object(
  {
    ...envelope,
    type: Type.Literal("egress"),
    agent: NonEmpty,
    role: NonEmpty,
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    /** What the agent asked for, e.g. "pypi.org:443" or "GET http://example.com/". */
    target: Type.String(),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const EngineEvent = Type.Union([MessageEvent, ToolCallEvent, ToolResultEvent, UsageEvent, ApprovalEvent, EgressEvent]);

export type MessageEvent = Type.Static<typeof MessageEvent>;
export type ToolCallEvent = Type.Static<typeof ToolCallEvent>;
export type ToolResultEvent = Type.Static<typeof ToolResultEvent>;
export type Tokens = Type.Static<typeof Tokens>;
export type UsageEvent = Type.Static<typeof UsageEvent>;
export type ApprovalEvent = Type.Static<typeof ApprovalEvent>;
export type EgressEvent = Type.Static<typeof EgressEvent>;
export type EngineEvent = Type.Static<typeof EngineEvent>;
export type EventType = EngineEvent["type"];
