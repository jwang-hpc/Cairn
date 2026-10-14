// One agent's executor endpoint (DR-0004 seam 4): the tool sets its role may use behind the authenticated front.
import type { AuditLog } from "../jobs/audit.js";
import type { JobService } from "../jobs/service.js";
import type { LiteratureService } from "../literature/service.js";
import { jobTools } from "./jobs.js";
import { literatureTools } from "./literature.js";
import { createEndpoint, createExecutorMcp, type ExecutorSession, type ToolSet } from "./server.js";

export function createExecutorEndpoint(opts: { jobs?: JobService; literature?: LiteratureService; audit?: AuditLog; session: ExecutorSession; token: string }): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
} {
  const audit = opts.audit ?? opts.jobs?.audit;
  if (!audit) throw new Error("the executor endpoint needs an audit log");
  const sets: ToolSet[] = [...(opts.jobs ? [jobTools(opts.jobs, opts.session)] : []), ...(opts.literature ? [literatureTools(opts.literature, opts.session)] : [])];
  return createEndpoint({ mcp: createExecutorMcp(sets, opts.session, audit), audit, project: opts.session.project, token: opts.token });
}
