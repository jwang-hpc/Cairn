// Parsers (DR-0007: evidence/ tables are written only by parsers and the executor). A parser is a standard-library
// Python script in packages/engine/parsers/ with one contract: `python3 -I <parser>.py <input> <out dir>`, tables
// into the out dir, a JSON manifest on stdout. In production it runs in the agent image (Python 3.12, no network,
// no model) with only its input and code mounted; tests run it on the host.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { ContainerRuntime, git, gitBlob, launchSandbox, type Sandbox, type SandboxOptions } from "@cairn/launcher";
import { type Provenance, provenance, type RolesConfig } from "@cairn/shared";
import { type Ledger, LedgerError } from "../ledger/ledger.js";
import { REPO_ROOT } from "../paths.js";

export const PARSERS_DIR = join(REPO_ROOT, "packages", "engine", "parsers");
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const OUTPUT_LIMIT = 50 << 20;

export interface ParserManifest {
  parser: string;
  version: number;
  outputs: { path: string; rows: number; description: string }[];
  notes: string[];
}

export interface ParserRun {
  manifest: ParserManifest;
  outputs: { path: string; content: Buffer }[];
}

export interface ParserRunner {
  run(parser: string, input: { name: string; content: Buffer }): Promise<ParserRun>;
}

interface RegistryEntry {
  parser: string;
  match: string;
  skip?: string[];
}

export async function loadRegistry(dir = PARSERS_DIR): Promise<RegistryEntry[]> {
  const r = JSON.parse(await readFile(join(dir, "registry.json"), "utf8")) as { parsers: RegistryEntry[] };
  for (const e of r.parsers) if (!NAME.test(e.parser)) throw new Error(`bad parser name ${e.parser}`);
  return r.parsers;
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
export const parsersFor = (registry: RegistryEntry[], file: string) =>
  registry.filter((e) => glob(e.match).test(posix.basename(file)) && !(e.skip ?? []).some((s) => glob(s).test(posix.basename(file)))).map((e) => e.parser);

/** Lay out in/<input>, code/<parser>.py, out/ in a fresh temp dir; read back what the parser wrote. */
async function stage(parser: string, input: { name: string; content: Buffer }, dir: string) {
  if (!NAME.test(parser) || !NAME.test(input.name)) throw new Error("bad parser or input name");
  const root = await mkdtemp(join(tmpdir(), "cairn-parse-"));
  for (const d of ["in", "code", "out", "skills", "outbox"]) await mkdir(join(root, d));
  await writeFile(join(root, "in", input.name), input.content);
  await writeFile(join(root, "code", `${parser}.py`), await readFile(join(dir, `${parser}.py`)));
  return root;
}

async function collect(root: string, stdout: string): Promise<ParserRun> {
  let manifest: ParserManifest;
  try {
    manifest = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as ParserManifest;
  } catch {
    throw new Error(`parser printed no manifest: ${stdout.slice(0, 200)}`);
  }
  const outputs: ParserRun["outputs"] = [];
  let total = 0;
  for (const name of (await readdir(join(root, "out"))).sort()) {
    const p = join(root, "out", name);
    // lstat, and open without following links: a parser must not hand the host a symlink to a host file.
    const s = await lstat(p);
    if (!s.isFile() || !NAME.test(name)) throw new Error(`parser wrote ${name}, which is not a regular file with a plain name`);
    total += s.size;
    if (total > OUTPUT_LIMIT) throw new Error(`parser output exceeds ${OUTPUT_LIMIT} bytes`);
    const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      outputs.push({ path: name, content: await h.readFile() });
    } finally {
      await h.close();
    }
  }
  const listed = new Set(manifest.outputs.map((o) => o.path));
  if (outputs.some((o) => !listed.has(o.path)) || listed.size !== outputs.length) throw new Error("parser manifest doesn't match the files it wrote");
  return { manifest, outputs };
}

/** Runs parsers in the agent image: no network, no model, only the input and the parser mounted. */
export class SandboxParserRunner implements ParserRunner {
  constructor(
    private readonly opts: { image: string; runtime?: ContainerRuntime; launch?: (o: SandboxOptions) => Promise<Sandbox>; dir?: string },
  ) {}

  async run(parser: string, input: { name: string; content: Buffer }): Promise<ParserRun> {
    const root = await stage(parser, input, this.opts.dir ?? PARSERS_DIR);
    const roles: RolesConfig = {
      roles: { parser: { mounts: { read: ["in/", "code/"], write: ["out/"] }, network: [], executor_tools: [] } },
      defaults: { secrets: "none", egress: "deny" },
    };
    try {
      const sb = await (this.opts.launch ?? launchSandbox)({
        runtime: this.opts.runtime ?? new ContainerRuntime(),
        request: { agentId: `parse-${randomBytes(3).toString("hex")}`, role: "parser", roles, worktree: root, skillsDir: join(root, "skills"), outboxDir: join(root, "outbox"), image: this.opts.image },
      });
      let r;
      try {
        r = await sb.exec(["python3", "-I", `/work/code/${parser}.py`, `/work/in/${input.name}`, "/work/out"], { timeoutMs: 300_000, maxOutputBytes: 1 << 20 });
      } finally {
        await sb.close();
      }
      if (r.code !== 0) throw new Error(`${parser} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
      return await collect(root, r.stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

/** Runs parsers with the host's python3 (tests). */
export class HostParserRunner implements ParserRunner {
  constructor(private readonly opts: { python?: string; dir?: string } = {}) {}

  async run(parser: string, input: { name: string; content: Buffer }): Promise<ParserRun> {
    const root = await stage(parser, input, this.opts.dir ?? PARSERS_DIR);
    try {
      const { stdout } = await promisify(execFile)(this.opts.python ?? "python3", ["-I", join(root, "code", `${parser}.py`), join(root, "in", input.name), join(root, "out")], {
        timeout: 300_000,
        maxBuffer: 1 << 20,
      });
      return await collect(root, stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Provenance of derived tables: the provenance of the evidence they derive from (MANIFEST.json author). */
function sourceProvenance(manifest: string | undefined): Provenance {
  try {
    const a = (JSON.parse(manifest ?? "") as { author?: { kind: string; model?: string; effort?: string } }).author;
    if (a?.kind === "agent" && a.model && a.effort) return provenance.aiExecuted(a.model, a.effort as "low");
  } catch {
    // no manifest: the user put the evidence there
  }
  return provenance.user;
}

export interface ParsedJob {
  job: string;
  inputs: { path: string; parser: string; outputs: string[]; notes: string[] }[];
}

/**
 * Parse the committed raw evidence of an experiment (all its jobs, or one) into evidence/tables/<EXP>/<job>/, one
 * tagged commit per job with a PARSED.json record (input hash, parser, version, outputs). Logs, MANIFEST.json and
 * the job's own files (job/) are not parsed.
 */
export async function parseEvidence(ledger: Ledger, sel: { experiment: string; job?: string }, runner: ParserRunner): Promise<ParsedJob[]> {
  if (!/^EXP-[0-9]{3,4}$/.test(sel.experiment)) throw new LedgerError(`experiment must be a name like EXP-001`);
  if (sel.job !== undefined && !/^[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$/.test(sel.job)) throw new LedgerError(`bad job id ${sel.job}`);
  const registry = await loadRegistry();
  const base = `evidence/raw/${sel.experiment}/`;
  const files = (await git(ledger.dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", base])).split("\n").filter(Boolean);
  const byJob = new Map<string, string[]>();
  for (const f of files) {
    const [job, ...rest] = f.slice(base.length).split("/");
    if (!job || (sel.job && job !== sel.job)) continue;
    byJob.set(job, [...(byJob.get(job) ?? []), rest.join("/")]);
  }
  if (byJob.size === 0) throw new LedgerError(`no committed evidence under ${base}${sel.job ?? ""}`);

  const done: ParsedJob[] = [];
  for (const [job, rels] of [...byJob].sort()) {
    const inputs: ParsedJob["inputs"] = [];
    const writes: { path: string; content: Buffer }[] = [];
    const record: unknown[] = [];
    for (const rel of rels.sort()) {
      if (rel === "MANIFEST.json" || rel.startsWith("logs/") || rel.startsWith("job/")) continue;
      for (const parser of parsersFor(registry, rel)) {
        const content = await gitBlob(ledger.dir, "HEAD", `${base}${job}/${rel}`);
        const r = await runner.run(parser, { name: posix.basename(rel), content });
        const dir = posix.join(`evidence/tables/${sel.experiment}/${job}`, posix.dirname(rel));
        for (const o of r.outputs) writes.push({ path: posix.join(dir, o.path), content: o.content });
        inputs.push({ path: `${base}${job}/${rel}`, parser, outputs: r.outputs.map((o) => posix.join(dir, o.path)), notes: r.manifest.notes });
        record.push({ input: `${base}${job}/${rel}`, input_sha256: sha256(content), parser, version: r.manifest.version, outputs: r.manifest.outputs.map((o) => ({ ...o, path: posix.join(dir, o.path) })), notes: r.manifest.notes });
      }
    }
    if (writes.length === 0) continue;
    writes.push({ path: `evidence/tables/${sel.experiment}/${job}/PARSED.json`, content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`) });
    const manifest = await git(ledger.dir, ["show", `HEAD:${base}${job}/MANIFEST.json`]).catch(() => undefined);
    await ledger.writeArtifacts(writes, sourceProvenance(manifest), `tables for ${sel.experiment} job ${job} (${inputs.map((i) => i.parser).join(", ")})`, "parse");
    done.push({ job, inputs });
  }
  return done;
}
