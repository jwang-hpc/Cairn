// Config file schemas (config/*.yaml). Structural validation only; cross-file rules (aliases exist,
// DOE machines never auto-approve, ...) live in the engine's config loader.
import Type from "typebox";
import { AuthKind } from "./events.js";

const NonEmpty = Type.String({ minLength: 1 });
const Positive = Type.Number({ exclusiveMinimum: 0 });
const PositiveInt = Type.Integer({ minimum: 1 });
const strict = { additionalProperties: false } as const;

/** DR-0013 data governance classes. */
export const DataClass = Type.Union([Type.Literal("public"), Type.Literal("unpublished"), Type.Literal("restricted")]);
export type DataClass = Type.Static<typeof DataClass>;

/** pi-ai reasoning levels that an engine effort level can map to. */
export const PiThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

/** "alias@effort", e.g. "claude-opus@high". */
export const ModelRef = Type.String({ pattern: "^[a-z0-9][a-z0-9-]*@(low|medium|high|max)$" });

// ---------- models.yaml ----------

export const Route = Type.Object(
  {
    /** pi-ai provider id that carries the call (anthropic, openai-codex, openai, google, ...). */
    pi_provider: NonEmpty,
    auth: AuthKind,
  },
  strict,
);

export const ProviderConfig = Type.Object(
  {
    /** Tried in order; later routes are fallbacks (DR-0010: subscription first, API key after). */
    routes: Type.Array(Route, { minItems: 1 }),
    data_classes: Type.Array(DataClass),
    /** When the user last reviewed this provider's terms; "unchecked" until then. */
    terms_checked: NonEmpty,
  },
  strict,
);

export const ModelConfig = Type.Object(
  {
    /** Vendor key into `providers`. */
    provider: NonEmpty,
    /** Native model id. Model IDs live only in config (DR-0012). */
    id: NonEmpty,
    /** Tool-use grade from evals (DR-0013); "untested" until measured. */
    tool_use: Type.Union([Type.Literal("untested"), Type.Literal("pass"), Type.Literal("fail")]),
    /** Override of pi-ai's catalog context window, if needed. */
    context: Type.Optional(PositiveInt),
  },
  strict,
);

export const EffortMap = Type.Object(
  { low: PiThinkingLevel, medium: PiThinkingLevel, high: PiThinkingLevel, max: PiThinkingLevel },
  strict,
);

export const RoutingEntry = Type.Object(
  {
    worker: Type.Optional(ModelRef),
    reviewer: Type.Optional(ModelRef),
    panel: Type.Optional(Type.Array(ModelRef, { minItems: 1 })),
    synthesizer: Type.Optional(ModelRef),
    fallback: Type.Optional(Type.Array(ModelRef)),
  },
  strict,
);

export const ModelsConfig = Type.Object(
  {
    providers: Type.Record(Type.String(), ProviderConfig),
    models: Type.Record(Type.String(), ModelConfig),
    effort_map: Type.Record(Type.String(), EffortMap),
    routing: Type.Record(Type.String(), RoutingEntry),
    projects_default_data_class: DataClass,
  },
  strict,
);

// ---------- roles.yaml ----------

export const RoleConfig = Type.Object(
  {
    mounts: Type.Object({ read: Type.Array(NonEmpty), write: Type.Array(NonEmpty) }, strict),
    network: Type.Array(NonEmpty),
    executor_tools: Type.Array(NonEmpty),
  },
  strict,
);

export const RolesConfig = Type.Object(
  {
    roles: Type.Record(Type.String(), RoleConfig),
    defaults: Type.Object(
      {
        /** DR-0004 seam 8. Only "none" is used for now. */
        secrets: Type.Union([Type.Literal("none"), Type.Literal("model-token")]),
        /** Invariant 3: egress is deny-by-default. */
        egress: Type.Literal("deny"),
      },
      strict,
    ),
  },
  strict,
);

// ---------- machines.yaml ----------

export const MachineConfig = Type.Object(
  {
    host: NonEmpty,
    scheduler: Type.Union([Type.Literal("none"), Type.Literal("slurm"), Type.Literal("pbs")]),
    account: Type.Optional(NonEmpty),
    partitions: Type.Optional(Type.Array(NonEmpty)),
    max: Type.Optional(
      Type.Object(
        { nodes: Type.Optional(PositiveInt), walltime: Type.Optional(Type.String({ pattern: "^\\d{1,3}:[0-5]\\d:[0-5]\\d$" })) },
        strict,
      ),
    ),
    auto_approve_below: Type.Optional(
      Type.Object({ cores: Type.Optional(PositiveInt), hours: Type.Optional(Positive), node_hours: Type.Optional(Positive) }, strict),
    ),
    /** DOE machine: Tier 0 only, never auto-approved (DR-0006). */
    doe: Type.Optional(Type.Boolean()),
    paths: Type.Optional(Type.Object({ allowed_prefixes: Type.Array(NonEmpty, { minItems: 1 }) }, strict)),
  },
  strict,
);

export const MachinesConfig = Type.Object({ machines: Type.Record(Type.String(), MachineConfig) }, strict);

// ---------- engine.yaml ----------

const Caps = (unit: typeof Positive | typeof PositiveInt) =>
  Type.Object({ total: Type.Optional(unit), per_provider: Type.Optional(Type.Record(Type.String(), unit)) }, strict);

export const EngineConfig = Type.Object(
  {
    /** Id of this physical machine, recorded on every usage record (e.g. "mbp", "workstation"). */
    machine: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    budget: Type.Object(
      {
        /** Local-day caps (DR-0010 layer 2). */
        daily: Type.Object(
          {
            /** Billed (API-key) calls, USD. */
            usd: Caps(Positive),
            /** Subscription calls, tokens (they cost no money but are rate-limited). */
            tokens: Caps(PositiveInt),
            per_role: Type.Optional(
              Type.Record(Type.String(), Type.Object({ usd: Type.Optional(Positive), tokens: Type.Optional(PositiveInt) }, strict)),
            ),
          },
          strict,
        ),
        /** Per-run caps: stop a runaway loop within one run. */
        run: Type.Object({ max_usd: Positive, max_tokens: PositiveInt, max_turns: PositiveInt }, strict),
      },
      strict,
    ),
    /** Agent sandboxes (DR-0005). */
    agent: Type.Optional(
      Type.Object(
        {
          /** Agent image built from containers/agent (ideally pinned by digest). Default: cairn-agent:dev. */
          image: Type.Optional(NonEmpty),
          /** Wall-clock limit for one worker run, in minutes. Default: 15. */
          max_minutes: Type.Optional(PositiveInt),
        },
        strict,
      ),
    ),
  },
  strict,
);

/** report.json an agent writes to /outbox (DR-0004 seam 2: judge by artifacts, not transcripts). */
export const WorkerReport = Type.Object(
  {
    status: Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("needs_input")]),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    notes: Type.Optional(Type.String({ maxLength: 20000 })),
    questions: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 20 })),
  },
  { additionalProperties: false },
);
export type WorkerReport = Type.Static<typeof WorkerReport>;

export type Route = Type.Static<typeof Route>;
export type ProviderConfig = Type.Static<typeof ProviderConfig>;
export type ModelConfig = Type.Static<typeof ModelConfig>;
export type EffortMap = Type.Static<typeof EffortMap>;
export type RoutingEntry = Type.Static<typeof RoutingEntry>;
export type ModelsConfig = Type.Static<typeof ModelsConfig>;
export type RoleConfig = Type.Static<typeof RoleConfig>;
export type RolesConfig = Type.Static<typeof RolesConfig>;
export type MachineConfig = Type.Static<typeof MachineConfig>;
export type MachinesConfig = Type.Static<typeof MachinesConfig>;
export type EngineConfig = Type.Static<typeof EngineConfig>;
export type PiThinkingLevel = Type.Static<typeof PiThinkingLevel>;
