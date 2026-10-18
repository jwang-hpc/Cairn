// Job formats (DR-0006). An agent writes experiments/EXP-NNN/job.json (the manifest) next to its script; the
// executor lints it against machines.yaml, snapshots the files, and asks for approval before anything runs.
import Type from "typebox";
import type { EffortLevel } from "./events.js";

/** Experiment names are names, never paths (DR-0006 step 1). */
export const EXPERIMENT_PATTERN = "^EXP-[0-9]{3,4}$";
/** Relative file path inside an experiment directory: no "..", no leading "." or "/", plain characters only. */
export const JOB_FILE_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$";
/** HH:MM:SS (hours may exceed 24). */
export const WALLTIME_PATTERN = "^[0-9]{1,3}:[0-5][0-9]:[0-5][0-9]$";
/** Job ids: <yyyymmdd>-<hhmm>-<4 hex>, same shape as panel ids. */
export const JOB_ID_PATTERN = "^[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$";

const strict = { additionalProperties: false } as const;
const JobPath = Type.String({ pattern: JOB_FILE_PATTERN, maxLength: 200 });

/** A campaign parameter value: a number, or a short plain word (it becomes an environment variable and a CSV cell). */
export const CampaignValue = Type.Union([Type.Number(), Type.String({ pattern: "^[A-Za-z0-9_.:+-]{1,64}$" })]);
/** Parameter names become P_<name> environment variables. */
export const CAMPAIGN_PARAM_PATTERN = "^[A-Za-z][A-Za-z0-9_]{0,30}$";
export const CAMPAIGN_MAX_POINTS = 1000;

/**
 * A campaign (DR-0011): the job's script runs once per point of a parameter grid, each point in its own directory
 * points/<NNNN>/ with its values as P_<name> environment variables. resources.walltime is the whole campaign's
 * budget: no point starts once it could not finish within it.
 */
export const CampaignSpec = Type.Object(
  {
    /** Every combination is one point, the first parameter varying slowest. */
    parameters: Type.Record(Type.String({ pattern: CAMPAIGN_PARAM_PATTERN }), Type.Array(CampaignValue, { minItems: 1, maxItems: CAMPAIGN_MAX_POINTS }), {
      ...strict,
      minProperties: 1,
    }),
    /** Wall-clock limit for one attempt at one point. */
    point_walltime: Type.String({ pattern: WALLTIME_PATTERN }),
    /** Points running at once (default 1); at most the job's cores. */
    parallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    /** Re-runs of a failed point (default 0). */
    retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  },
  strict,
);
export type CampaignSpec = Type.Static<typeof CampaignSpec>;

/** experiments/EXP-NNN/job.json */
export const JobManifest = Type.Object(
  {
    /** Entry point, run with bash from the job directory. */
    script: JobPath,
    /** One line for the approval card. */
    description: Type.Optional(Type.String({ maxLength: 500 })),
    resources: Type.Object(
      {
        /** Default 1. Must be 1 on machines without a scheduler. */
        nodes: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Cores per node. */
        cores: Type.Integer({ minimum: 1 }),
        /** Slurm tasks per node (default: one per core); must divide cores. */
        tasks_per_node: Type.Optional(Type.Integer({ minimum: 1 })),
        /** GPUs per node. Default 0. */
        gpus: Type.Optional(Type.Integer({ minimum: 0 })),
        /** Memory per node, GB. */
        memory_gb: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        walltime: Type.String({ pattern: WALLTIME_PATTERN }),
        /** Slurm partition; defaults to the machine's first allowed partition. */
        partition: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.-]+$" })),
      },
      strict,
    ),
    /** Small result files (relative to the job directory) that jobs.fetch_results copies into evidence/raw/. */
    outputs: Type.Array(JobPath, { maxItems: 50 }),
    /** Run the script once per point of a parameter grid (DR-0011). Outputs are then per point. */
    campaign: Type.Optional(CampaignSpec),
  },
  strict,
);
export type JobManifest = Type.Static<typeof JobManifest>;

export const JOB_STATES = ["pending_approval", "denied", "approved", "submitted", "running", "completed", "failed", "cancelled", "lost"] as const;
export type JobState = (typeof JOB_STATES)[number];
/** States after which the job never changes. "lost" is not one: the machine is asked again on the next status. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ["denied", "completed", "failed", "cancelled"];

/** Who wrote the job: an agent run (model + effort feed provenance) or the user. */
export type JobAuthor =
  | { kind: "agent"; run: string; agent: string; role: string; model: string; effort: EffortLevel }
  | { kind: "user" };

export interface JobFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface JobLint {
  errors: string[];
  /** Shown on the approval card; any warning rules out auto-approval. */
  warnings: string[];
  nodes: number;
  cores: number;
  gpus: number;
  walltime_s: number;
  node_hours: number;
  partition?: string;
  account?: string;
  /** For a campaign: its size and the time the grid needs at that parallelism (no retries). */
  /** estimate_s: the grid at its point limits, without queue waits; task_walltime_s: a Slurm array task's limit. */
  campaign?: { points: number; parallel: number; retries: number; point_walltime_s: number; estimate_s: number; task_walltime_s?: number };
}

export interface JobRecord {
  v: 1;
  id: string;
  project: string;
  experiment: string;
  target: string;
  state: JobState;
  created: string;
  author: JobAuthor;
  /** Branch the job files came from (agent worktree), for review. */
  branch?: string;
  manifest: JobManifest;
  files: JobFile[];
  /** sha256 over all files (path + content); identical reruns share it. */
  fingerprint: string;
  lint: JobLint;
  /** Slurm `sbatch --test-only` result, when it could run. */
  preflight?: { ok: boolean; detail: string };
  approval?: { by: "user" | "auto"; at: string; note?: string };
  denial?: { at: string; reason: string };
  /** Launch attempts so far; attempt n > 1 uses <job>-r<n> as its remote directory. */
  attempts?: number;
  remote?: { host: string; dir: string; id: string; submitted: string };
  /** dir: ledger directory (evidence/raw/EXP-NNN/<job>); referenced: too large to copy, left on the machine. */
  results?: {
    at: string;
    dir: string;
    files: string[];
    referenced: { path: string; bytes: number }[];
    missing: string[];
    refused: { path: string; reason: string }[];
  };
  error?: string;
  history: { at: string; state: JobState; note?: string }[];
}
