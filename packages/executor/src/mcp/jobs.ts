// jobs.* as an MCP server (DR-0006, DR-0004 seam 4) for one agent session: the session fixes the project, the
// worktree, the author, and which tools the role may use (roles.yaml executor_tools). Approval is out-of-band
// (seam 5, spike 2 F2): jobs.submit returns pending_approval and the agent polls jobs.status. No MCP tool can
// approve anything. The server sits behind the authenticated front (bearer token, Host, path).
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EXPERIMENT_PATTERN, JOB_ID_PATTERN, type EffortLevel, type JobRecord, type MachineConfig } from "@cairn/shared";
import { createFront } from "../front.js";
import type { JobService } from "../jobs/service.js";
import type { JobFileContent } from "../jobs/lint.js";
import { JobError } from "../jobs/store.js";

export const JOB_TOOLS = ["jobs.submit", "jobs.status", "jobs.fetch_results", "jobs.cancel"] as const;
export type JobTool = (typeof JOB_TOOLS)[number];

export interface ExecutorSession {
  project: string;
  /** Host path of the agent's worktree (never sent to the model). */
  worktree: string;
  branch?: string;
  agent: { run: string; agent: string; role: string; model: string; effort: EffortLevel };
  /** roles.yaml executor_tools for the agent's role. */
  tools: readonly string[];
  /** Reads experiments/<name>/ inside the agent's sandbox (see SubmitRequest.read). */
  read?: (experiment: string) => Promise<JobFileContent[]>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function machineLine(name: string, m: MachineConfig): string {
  const limits = [
    m.max?.nodes ? `≤ ${m.max.nodes} nodes` : m.scheduler === "none" ? "1 node" : "",
    m.max?.cores ? `≤ ${m.max.cores} cores/node` : "",
    m.max?.gpus !== undefined ? `≤ ${m.max.gpus} GPUs/node` : "",
    m.max?.walltime ? `walltime ≤ ${m.max.walltime}` : "",
    m.partitions ? `partitions ${m.partitions.join("/")}` : "",
  ].filter(Boolean);
  return `- ${name}: ${m.scheduler === "none" ? "workstation, no scheduler" : m.scheduler}${limits.length ? `; ${limits.join(", ")}` : ""}${m.doe ? "; DOE machine (every job needs approval)" : ""}`;
}

function toolDefs(machines: Record<string, MachineConfig>) {
  const targets = Object.keys(machines);
  return {
    "jobs.submit": {
      name: "jobs.submit",
      title: "Submit a job",
      description: [
        "Submit experiments/<experiment>/ from your workspace as a job on a compute machine. Pass the experiment NAME (e.g. EXP-001), never a path.",
        "Nothing runs until the user approves it; then poll jobs.status. Every file in that directory is uploaded (≤ 100 files, ≤ 4 MiB total).",
        'job.json: {"script": "run.sh", "description": "<one line for the user>", "resources": {"cores": 4, "walltime": "HH:MM:SS", "nodes": 1, "gpus": 0, "memory_gb": 8, "partition": "<optional>"}, "outputs": ["results.csv"]}',
        "The script runs with bash from the job directory on the machine. Do not write #SBATCH lines (the executor writes them). Not allowed: ssh/scp, sudo, nohup/setsid/tmux, sbatch, '..' paths, absolute paths outside the machine's project/scratch areas, reading credentials, piping downloads into a shell.",
        "outputs: small result files (paths relative to the job directory) that jobs.fetch_results copies into the project's evidence/raw/ afterwards.",
        "Machines:",
        ...Object.entries(machines).map(([n, m]) => machineLine(n, m)),
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          experiment: { type: "string", pattern: EXPERIMENT_PATTERN, description: "Experiment name, e.g. EXP-001" },
          target: { type: "string", enum: targets, description: "Machine from the list above" },
        },
        required: ["experiment", "target"],
        additionalProperties: false,
      },
    },
    "jobs.status": {
      name: "jobs.status",
      title: "Job status",
      description: "State of one job (asks the machine if it is running), or of this project's recent jobs when job_id is omitted.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string", pattern: JOB_ID_PATTERN, description: "Job id from jobs.submit" } },
        additionalProperties: false,
      },
    },
    "jobs.fetch_results": {
      name: "jobs.fetch_results",
      title: "Fetch job results",
      description:
        "Copy a finished job's declared outputs (and log tails) into the project's evidence/raw/<experiment>/<job>/. Default: the latest finished job of the experiment. Large files stay on the machine and are listed by path.",
      inputSchema: {
        type: "object",
        properties: {
          experiment: { type: "string", pattern: EXPERIMENT_PATTERN },
          job_id: { type: "string", pattern: JOB_ID_PATTERN, description: "Optional: a specific job of that experiment" },
        },
        required: ["experiment"],
        additionalProperties: false,
      },
    },
    "jobs.cancel": {
      name: "jobs.cancel",
      title: "Cancel a job",
      description: "Withdraw a job that is waiting for approval, or stop a running one.",
      inputSchema: { type: "object", properties: { job_id: { type: "string", pattern: JOB_ID_PATTERN } }, required: ["job_id"], additionalProperties: false },
    },
  } satisfies Record<JobTool, unknown>;
}

/** What the agent sees about a job: state, what happens next, nothing about hosts' filesystems beyond the job. */
export function describeJob(j: JobRecord): string {
  const head = `job ${j.id}: ${j.state} (${j.experiment} on ${j.target})`;
  const last = j.history.at(-1)?.note;
  switch (j.state) {
    case "pending_approval":
      return `${head}\nWaiting for the user to approve it (they review it with \`re job show ${j.id}\`). Poll jobs.status; do not resubmit.`;
    case "denied":
      return `${head}\nThe user denied it: ${j.denial?.reason ?? "(no reason)"}. Revise the job and submit it again if that makes sense.`;
    case "approved":
      return `${head}\n${j.error ? `Approved, but it could not be started yet: ${j.error}. The user has to open the session; nothing for you to do.` : "Approved; starting."}`;
    case "submitted":
    case "running":
      return `${head}\n${j.state === "submitted" ? "Queued" : "Running"} since ${j.remote?.submitted ?? "?"}${last ? ` (${last})` : ""}. Poll jobs.status again later.`;
    default: {
      const r = j.results;
      const fetched = r
        ? `Results fetched into ${r.dir}/: ${r.files.join(", ") || "(none)"}${r.missing.length ? `; missing: ${r.missing.join(", ")}` : ""}${r.referenced.length ? `; left on the machine: ${r.referenced.map((x) => `${x.path} (${x.bytes} bytes)`).join(", ")}` : ""}${r.refused.length ? `; refused: ${r.refused.map((x) => `${x.path} (${x.reason})`).join(", ")}` : ""}.`
        : j.remote
          ? "Use jobs.fetch_results to copy its outputs into the project."
          : "";
      return `${head}${last ? `\n${last}` : ""}${fetched ? `\n${fetched}` : ""}`;
    }
  }
}

export interface JobsMcp {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createJobsMcp(service: JobService, session: ExecutorSession): JobsMcp {
  const machines = service.opts.machines;
  const defs = toolDefs(machines);
  const allowed = JOB_TOOLS.filter((t) => session.tools.includes(t));
  const actor = `agent:${session.agent.agent}`;
  const author = { kind: "agent" as const, ...session.agent };
  const audit = (tool: string, okFlag: boolean, detail: string) =>
    service.audit.append({ actor, project: session.project, action: `tool ${tool}`, ok: okFlag, detail });

  const mine = async (id: unknown): Promise<JobRecord> => {
    if (typeof id !== "string" || !new RegExp(JOB_ID_PATTERN).test(id)) throw new JobError(`job_id must look like 20261014-0300-ab12, not ${JSON.stringify(id)}`);
    const j = await service.get(id);
    if (j.project !== session.project) throw new JobError(`no job ${id} in project ${session.project}`);
    return j;
  };

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name as JobTool) {
      case "jobs.submit": {
        const { job, auto } = await service.submit({
          project: session.project,
          worktree: session.worktree,
          ...(session.branch ? { branch: session.branch } : {}),
          experiment: String(args.experiment ?? ""),
          target: String(args.target ?? ""),
          author,
          ...(session.read ? { read: session.read } : {}),
        });
        return ok(auto.ok ? `Auto-approved (${auto.reason}).\n${describeJob(job)}` : describeJob(job));
      }
      case "jobs.status": {
        if (args.job_id === undefined) {
          const jobs = (await service.list({ project: session.project })).slice(-10);
          return ok(jobs.length ? jobs.map((j) => `${j.id}  ${j.state.padEnd(16)} ${j.experiment} on ${j.target}`).join("\n") : "No jobs in this project yet.");
        }
        const j = await mine(args.job_id);
        return ok(describeJob(await service.refresh(j.id)));
      }
      case "jobs.fetch_results": {
        const experiment = String(args.experiment ?? "");
        if (!new RegExp(EXPERIMENT_PATTERN).test(experiment)) throw new JobError(`experiment must be a name like EXP-001`);
        let job: JobRecord | undefined;
        if (args.job_id !== undefined) {
          job = await mine(args.job_id);
          if (job.experiment !== experiment) throw new JobError(`job ${job.id} belongs to ${job.experiment}, not ${experiment}`);
        } else {
          const candidates = (await service.list({ project: session.project })).filter((j) => j.experiment === experiment && j.remote);
          for (const c of candidates.reverse()) {
            const fresh = await service.refresh(c.id);
            if (["completed", "failed", "cancelled"].includes(fresh.state)) {
              job = fresh;
              break;
            }
          }
          if (!job) throw new JobError(`no finished job for ${experiment} in this project (check jobs.status)`);
        }
        return ok(describeJob(await service.fetch(job.id)));
      }
      case "jobs.cancel": {
        const j = await mine(args.job_id);
        return ok(describeJob(await service.cancel(j.id, actor)));
      }
    }
    return fail(`unknown tool ${name}`);
  }

  function server(): Server {
    const s = new Server({ name: "cairn-executor-jobs", version: "0.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed.map((t) => defs[t]) }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      if (!(allowed as readonly string[]).includes(name)) {
        await audit(name, false, `not allowed for role ${session.agent.role}`);
        return fail(`${name} is not available to the ${session.agent.role} role`);
      }
      try {
        const r = await call(name, args);
        await audit(name, true, JSON.stringify(args));
        return r;
      } catch (e) {
        await audit(name, false, `${JSON.stringify(args)}: ${(e as Error).message}`);
        if (e instanceof JobError) return fail((e as Error).message);
        return fail(`executor error: ${(e as Error).message}`);
      }
    });
    return s;
  }

  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  return {
    async handle(request) {
      const sid = request.headers.get("mcp-session-id");
      let transport = sid ? sessions.get(sid) : undefined;
      if (sid && !transport) return new Response(JSON.stringify({ error: "unknown session" }), { status: 404, headers: { "content-type": "application/json" } });
      if (!transport) {
        const t = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, t),
          onsessionclosed: (id) => void sessions.delete(id),
        });
        await server().connect(t);
        transport = t;
      }
      return transport.handleRequest(request);
    },
    async close() {
      for (const t of sessions.values()) await t.close();
      sessions.clear();
    },
  };
}

/**
 * One agent's executor endpoint: the authenticated front (per-session bearer token, Host, path) in front of the
 * jobs MCP server. In-process: `fetch` goes straight to the front, no socket (spike 2 F5); serveFront() can put the
 * same front on a loopback port later.
 */
export function createExecutorEndpoint(opts: { service: JobService; session: ExecutorSession; token: string }): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
} {
  const mcp = createJobsMcp(opts.service, opts.session);
  const front = createFront({
    token: opts.token,
    handler: (r) => mcp.handle(r),
    onAudit: (e) => {
      if (e.event === "reject") {
        void opts.service.audit
          .append({ actor: "http", project: opts.session.project, action: "http", ok: false, detail: `${e.status} ${e.reason} (${e.method} ${e.path})` })
          .catch(() => {});
      }
    },
  });
  return {
    fetch: (input, init) => front.handle(input instanceof Request ? input : new Request(input, init)),
    close: () => mcp.close(),
  };
}
