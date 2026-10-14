// Engine side of the executor's jobs service (DR-0006): job records (engine/jobs/<id>.json) and fetched evidence
// (evidence/raw/<EXP>/<job>/) become tagged ledger commits in the job's project.
import { join } from "node:path";
import { type JobLedger, JobService, type JobServiceOptions } from "@cairn/executor";
import type { Engine } from "../engine.js";
import { projectsDir } from "../ledger/commands.js";
import { Ledger, LedgerError, PROJECT_NAME } from "../ledger/ledger.js";

export function jobLedger(projects: string): (project: string) => Promise<JobLedger> {
  return async (project) => {
    if (!PROJECT_NAME.test(project)) throw new LedgerError(`bad project name ${JSON.stringify(project)}`);
    const ledger = await Ledger.open(join(projects, project));
    return {
      write: (job, prov, summary, evidence = []) =>
        ledger.writeArtifacts([{ path: `engine/jobs/${job.id}.json`, content: `${JSON.stringify(job, null, 2)}\n` }, ...evidence], prov, summary, "job"),
    };
  };
}

/** The engine's jobs service: machines from machines.yaml, state in the engine home, records in project ledgers. */
export function openJobService(engine: Engine, overrides: Partial<JobServiceOptions> = {}): JobService {
  return new JobService({
    home: engine.paths.home,
    machines: engine.config.machines.machines,
    ledger: jobLedger(projectsDir(engine)),
    ...overrides,
  });
}
