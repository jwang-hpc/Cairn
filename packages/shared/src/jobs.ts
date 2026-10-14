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
  },
  strict,
);
export type JobManifest = Type.Static<typeof JobManifest>;

export const JOB_STATES = ["pending_approval", "denied", "approved", "submitted", "running", "completed", "failed", "cancelled", "lost"] as const;
export type JobState = (typeof JOB_STATES)[number];
/** States after which the job never changes on the remote side. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ["denied", "completed", "failed", "cancelled", "lost"];

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
  remote?: { host: string; dir: string; id: string; submitted: string };
  results?: { at: string; dir: string; files: string[]; referenced: { path: string; bytes: number }[]; missing: string[] };
  error?: string;
  history: { at: string; state: JobState; note?: string }[];
}
