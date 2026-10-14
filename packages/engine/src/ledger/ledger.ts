// Project ledger (DR-0007): one ARA artifact per git repository. Every write goes through this class, carries a
// provenance tag, is appended to engine/ledger.jsonl, and is one git commit with a Cairn-Provenance trailer.
// logic/claims.md is never written here: claims enter only through the claim gate (invariant 5, M6).
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { AGENT_AUTHOR, git } from "@cairn/launcher";
import {
  type DataClass,
  type ExplorationNode,
  type Hypothesis,
  type HypothesisInput,
  HypothesisInput as HypothesisInputSchema,
  type HypothesisStatus,
  isHumanProvenance,
  isProvenance,
  type LedgerWrite,
  LedgerWrite as LedgerWriteSchema,
  NODE_REQUIRED,
  type NodeType,
  type Provenance,
  validate,
} from "@cairn/shared";
import { parseDocument, stringify } from "yaml";
import { nextId, parseEntries, renderEntry } from "./markdown.js";
import { appendNode, flatten, renderTree, validateTree } from "./tree.js";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TREE = "trace/exploration_tree.yaml";
const HYPOTHESES = "logic/hypotheses.md";
const DECISIONS = "engine/decisions.md";
const LOG = "engine/ledger.jsonl";
/** Reserved for the claim gate (invariant 5). */
const CLAIM_GATED = new Set(["logic/claims.md"]);
/** Where engine artifacts may be written via writeArtifacts(): panel rounds, job records, executor evidence. */
const ARTIFACT_AREAS = ["engine/panels/", "engine/jobs/", "evidence/raw/"];

const pad = (n: number) => String(n).padStart(2, "0");
/** ARA timestamp: local "YYYY-MM-DDTHH:MM". */
export const araTimestamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const day = (d: Date) => araTimestamp(d).slice(0, 10);

export interface NewProject {
  projectsDir: string;
  name: string;
  title: string;
  dataClass: DataClass;
  authors?: string[];
  venue?: string;
  keywords?: string[];
}

export type NodeInput = { type: NodeType; title: string; parent?: string; also_depends_on?: string[] } & Partial<
  Record<"description" | "choice" | "result" | "hypothesis" | "failure_mode" | "lesson" | "from" | "to" | "trigger", string>
> & { alternatives?: string[]; evidence?: string[] | string; status?: "open" | "resolved" | "unresolved" };

/** ARA skeleton at the project root (DR-0007), plus engine/ bookkeeping. */
function skeleton(p: NewProject, created: string): Record<string, string> {
  const front = stringify({
    title: p.title,
    authors: p.authors ?? [],
    year: Number(created.slice(0, 4)),
    venue: p.venue ?? "",
    ara_version: "1.0",
    keywords: p.keywords ?? [],
    claims_summary: [],
    abstract: "",
    cairn_project: p.name,
    data_class: p.dataClass,
    created,
  }).trimEnd();
  const paper = `---\n${front}\n---\n\n# ${p.title}\n\n## Layer Index\n\n| Layer | Files |\n|---|---|\n| Cognitive (\`/logic\`) | [problem.md](logic/problem.md), [hypotheses.md](logic/hypotheses.md), [claims.md](logic/claims.md) (claim-gated), [experiments.md](logic/experiments.md), [related_work.md](logic/related_work.md) |\n| Physical (\`/src\`) | [environment.md](src/environment.md) |\n| Exploration (\`/trace\`) | [exploration_tree.yaml](trace/exploration_tree.yaml) |\n| Evidence (\`/evidence\`) | [README.md](evidence/README.md) |\n| Literature (\`/lit\`) | notes/, refs.bib |\n`;
  return {
    "PAPER.md": paper,
    "logic/problem.md": "# Problem\n",
    "logic/claims.md": "# Claims\n\n<!-- Written only through Cairn's claim gate (support check, rigor review, user approval). -->\n",
    [HYPOTHESES]: "# Hypotheses\n\n<!-- Recorded before experiments: prediction, falsification, baseline, decisive experiment, kill criteria. -->\n",
    "logic/experiments.md": "# Experiments\n",
    "logic/related_work.md": "# Related Work\n",
    "logic/solution/heuristics.md": "# Heuristics\n",
    "logic/solution/constraints.md": "# Constraints\n",
    "src/environment.md": "# Environment\n",
    [TREE]: "# Exploration tree (append-only; ARA research-manager schema)\ntree: []\n",
    "trace/sessions/session_index.yaml": "sessions: []\n",
    "staging/observations.yaml": "observations: []\n",
    "evidence/README.md": "# Evidence Index\n\n<!-- Written only by parsers and the executor. -->\n",
    "evidence/tables/.gitkeep": "",
    "evidence/figures/.gitkeep": "",
    "evidence/raw/.gitkeep": "",
    "lit/notes/.gitkeep": "",
    "lit/refs.bib": "",
    "drafts/.gitkeep": "",
    [DECISIONS]: "# Decisions\n",
    [LOG]: "",
  };
}

export class Ledger {
  private constructor(
    readonly dir: string,
    readonly name: string,
    readonly dataClass: DataClass,
    readonly now: () => Date,
  ) {}

  /** Create a new project repository with the ARA skeleton; the first commit is the user's. */
  static async create(p: NewProject, now: () => Date = () => new Date()): Promise<Ledger> {
    if (!PROJECT_NAME.test(p.name)) throw new LedgerError(`project name must match ${PROJECT_NAME}`);
    if (p.title.trim() === "") throw new LedgerError("project title must not be empty");
    const dir = join(p.projectsDir, p.name);
    if (await stat(dir).then(() => true, () => false)) throw new LedgerError(`project already exists: ${dir}`);
    const created = araTimestamp(now());
    try {
      for (const [file, content] of Object.entries(skeleton(p, created))) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), content);
      }
      // No template: no sample hooks in project repos (engine-run git disables hooks anyway).
      await git(dir, ["init", "--quiet", "-b", "main", "--template="]);
      const ledger = new Ledger(dir, p.name, p.dataClass, now);
      await ledger.#commit("create", "PAPER.md", undefined, "user", `create project ${p.name}: ${p.title}`, ["."]);
      return ledger;
    } catch (e) {
      // Never leave a half-made project behind (a stray dir would also let git walk up to a parent repo).
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /** Open an existing project (must have been created by Cairn: PAPER.md front matter cairn_project). */
  static async open(dir: string, now: () => Date = () => new Date()): Promise<Ledger> {
    let paper: string;
    try {
      paper = await readFile(join(dir, "PAPER.md"), "utf8");
    } catch {
      throw new LedgerError(`not a Cairn project (no PAPER.md): ${dir}`);
    }
    const fm = /^---\n([\s\S]*?)\n---/.exec(paper);
    const meta = fm ? (parseDocument(fm[1]!).toJS() as Record<string, unknown>) : {};
    if (typeof meta.cairn_project !== "string") throw new LedgerError(`not a Cairn project (PAPER.md has no cairn_project): ${dir}`);
    const dc = meta.data_class;
    if (dc !== "public" && dc !== "unpublished" && dc !== "restricted") throw new LedgerError(`PAPER.md data_class must be public, unpublished, or restricted`);
    return new Ledger(dir, meta.cairn_project, dc, now);
  }

  // ---------- reads ----------

  async tree(): Promise<ExplorationNode[]> {
    const doc = parseDocument(await readFile(join(this.dir, TREE), "utf8"));
    if (doc.errors.length > 0) throw new LedgerError(`${TREE}: ${doc.errors[0]!.message}`);
    return validateTree((doc.toJS() as { tree?: unknown } | null)?.tree ?? []);
  }

  async renderTree(): Promise<string> {
    return renderTree(await this.tree());
  }

  async hypotheses(): Promise<Hypothesis[]> {
    const md = await readFile(join(this.dir, HYPOTHESES), "utf8");
    return parseEntries(md, /^HY\d+$/).map((e) => ({
      id: e.id,
      title: e.title,
      statement: e.fields.Statement ?? "",
      prediction: e.fields.Prediction ?? "",
      falsification: e.fields.Falsification ?? "",
      baseline: e.fields.Baseline ?? "",
      decisive_experiment: e.fields["Decisive experiment"] ?? "",
      kill_criteria: e.fields["Kill criteria"] ?? "",
      status: (e.fields.Status ?? "proposed") as HypothesisStatus,
      provenance: e.fields.Provenance ?? "",
      opened: e.fields.Opened ?? "",
    }));
  }

  async writes(): Promise<LedgerWrite[]> {
    const text = await readFile(join(this.dir, LOG), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerWrite);
  }

  // ---------- writes (all tagged, logged, committed) ----------

  /** Append an exploration node (journey fact; direct-routed, append-only). Returns its id. */
  async addNode(input: NodeInput, prov: Provenance): Promise<string> {
    this.#requireProvenance(prov);
    for (const f of NODE_REQUIRED[input.type]) {
      if ((input as Record<string, unknown>)[f] === undefined) throw new LedgerError(`${input.type} node needs '${f}'`);
    }
    const path = join(this.dir, TREE);
    const doc = parseDocument(await readFile(path, "utf8"));
    const existing = validateTree((doc.toJS() as { tree?: unknown } | null)?.tree ?? []);
    const ids = flatten(existing).map((x) => x.node.id);
    for (const ref of [...(input.also_depends_on ?? []), ...(input.parent ? [input.parent] : [])]) {
      if (!ids.includes(ref)) throw new LedgerError(`unknown node ${ref}`);
    }
    const id = nextId("N", ids);
    const { parent, ...fields } = input;
    const node = { id, ...fields, provenance: prov, timestamp: araTimestamp(this.now()) } as ExplorationNode;
    validateTree([...existing, node]); // the result must still be a valid tree
    appendNode(doc, node, parent);
    await writeFile(path, doc.toString());
    await this.#commit("add-node", TREE, id, prov, `${input.type} ${id}: ${input.title}`);
    return id;
  }

  /** Record a hypothesis (DR-0007 fields) and open a `question` node for it. */
  async addHypothesis(input: HypothesisInput, prov: Provenance, opts: { parent?: string } = {}): Promise<{ id: string; node: string }> {
    this.#requireProvenance(prov);
    const r = validate(HypothesisInputSchema, input);
    if (!r.ok) throw new LedgerError(`hypothesis: ${r.errors.join("; ")}`);
    const existing = await this.hypotheses();
    const id = nextId("HY", existing.map((h) => h.id));
    const node = await this.addNode(
      { type: "question", title: `${id}: ${input.title}`, description: input.statement, status: "open", ...(opts.parent ? { parent: opts.parent } : {}) },
      prov,
    );
    const entry = renderEntry({
      id,
      title: input.title,
      fields: {
        Statement: input.statement,
        Prediction: input.prediction,
        Falsification: input.falsification,
        Baseline: input.baseline,
        "Decisive experiment": input.decisive_experiment,
        "Kill criteria": input.kill_criteria,
        Status: "proposed",
        Provenance: prov,
        Opened: `${node} (${day(this.now())})`,
      },
    });
    await appendFile(join(this.dir, HYPOTHESES), `\n${entry}`);
    await this.#commit("add-hypothesis", HYPOTHESES, id, prov, `hypothesis ${id}: ${input.title}`);
    return { id, node };
  }

  /** Human gate 1 (DR-0001): only the user selects hypotheses to pursue. Records a decision node and decisions.md. */
  async approveHypothesis(id: string, prov: Provenance, note?: string): Promise<{ decision: string; node: string }> {
    this.#requireProvenance(prov);
    if (!isHumanProvenance(prov)) throw new LedgerError(`approving ${id} is a human decision; provenance must be user or user-revised, not ${prov}`);
    const h = (await this.hypotheses()).find((x) => x.id === id);
    if (!h) throw new LedgerError(`unknown hypothesis ${id}`);
    if (h.status !== "proposed") throw new LedgerError(`${id} is ${h.status}, not proposed`);
    const opened = /^(N\d+)/.exec(h.opened)?.[1];
    const node = await this.addNode(
      {
        type: "decision",
        title: `Pursue ${id}: ${h.title}`,
        choice: `Pursue ${id}`,
        alternatives: ["Do not pursue"],
        evidence: opened ? [opened] : [],
        ...(opened ? { parent: opened } : {}),
      },
      prov,
    );
    await this.#setHypothesisField(id, "Status", "approved");
    const decision = await this.#appendDecision(`Pursue ${id} — ${h.title}`, prov, [id, node], note);
    await this.#commit("approve-hypothesis", HYPOTHESES, id, prov, `approve ${id} (${decision}, ${node})`, [HYPOTHESES, DECISIONS]);
    return { decision, node };
  }

  /** Free-form decision (engine/decisions.md), e.g. scope or method choices. */
  async addDecision(title: string, prov: Provenance, refs: string[] = [], note?: string): Promise<string> {
    this.#requireProvenance(prov);
    const id = await this.#appendDecision(title, prov, refs, note);
    await this.#commit("add-decision", DECISIONS, id, prov, `decision ${id}: ${title}`);
    return id;
  }

  /** Read a project file (relative path). */
  async read(rel: string): Promise<string> {
    const p = posix.normalize(rel);
    if (p.startsWith("..") || p.startsWith("/")) throw new LedgerError(`path outside the project: ${rel}`);
    return readFile(join(this.dir, p), "utf8");
  }

  /**
   * Engine artifacts (panel rounds, job records, and executor evidence under evidence/raw/, DR-0007). One tagged commit
   * per call; paths outside the artifact areas are refused.
   */
  async writeArtifacts(files: { path: string; content: string | Uint8Array }[], prov: Provenance, summary: string, op = "write-artifact"): Promise<void> {
    this.#requireProvenance(prov);
    if (files.length === 0) throw new LedgerError("nothing to write");
    const paths: string[] = [];
    for (const f of files) {
      const p = posix.normalize(f.path);
      if (p.split("/").includes("..") || !ARTIFACT_AREAS.some((a) => p.startsWith(a))) {
        throw new LedgerError(`artifacts may only be written under ${ARTIFACT_AREAS.join(", ")}: ${f.path}`);
      }
      await mkdir(dirname(join(this.dir, p)), { recursive: true });
      await writeFile(join(this.dir, p), f.content);
      paths.push(p);
    }
    await this.#commit(op, paths[0]!, undefined, prov, summary, paths);
  }

  /** Verify every write is tagged: ledger.jsonl entries, git commits, tree nodes, hypotheses. */
  async check(): Promise<{ ok: boolean; problems: string[]; writes: number; commits: number }> {
    const problems: string[] = [];
    const writes = await this.writes();
    writes.forEach((w, i) => {
      const r = validate(LedgerWriteSchema, w);
      if (!r.ok) problems.push(`${LOG} line ${i + 1}: ${r.errors.join("; ")}`);
    });
    const log = await git(this.dir, ["log", "--format=%H%x1f%(trailers:key=Cairn-Provenance,valueonly,separator=%x2c)%x1f%s%x1e"]);
    const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean);
    for (const c of commits) {
      const [sha, trailer, subject] = c.split("\x1f");
      if (!trailer || !isProvenance(trailer.trim())) problems.push(`commit ${sha!.slice(0, 12)} "${subject}" has no valid Cairn-Provenance (edited outside the ledger?)`);
    }
    for (const { node } of flatten(await this.tree())) if (!isProvenance(node.provenance)) problems.push(`node ${node.id} has invalid provenance`);
    for (const h of await this.hypotheses()) if (!isProvenance(h.provenance)) problems.push(`${h.id} has invalid provenance`);
    const dirty = (await git(this.dir, ["status", "--porcelain"])).trim();
    if (dirty) problems.push(`uncommitted changes outside the ledger:\n${dirty}`);
    return { ok: problems.length === 0, problems, writes: writes.length, commits: commits.length };
  }

  // ---------- internals ----------

  #requireProvenance(prov: Provenance): void {
    if (!isProvenance(prov)) {
      throw new LedgerError(`invalid provenance ${JSON.stringify(prov)}; use user, user-revised, ai-suggested(<model>, <effort>), or ai-executed(<model>, <effort>)`);
    }
  }

  async #setHypothesisField(id: string, field: string, value: string): Promise<void> {
    const path = join(this.dir, HYPOTHESES);
    const lines = (await readFile(path, "utf8")).split("\n");
    let inEntry = false;
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) inEntry = lines[i]!.startsWith(`## ${id}:`);
      else if (inEntry && lines[i]!.startsWith(`- **${field}**: `)) {
        lines[i] = `- **${field}**: ${value}`;
        done = true;
      }
    }
    if (!done) throw new LedgerError(`${id} has no ${field} field`);
    await writeFile(path, lines.join("\n"));
  }

  async #appendDecision(title: string, prov: Provenance, refs: string[], note?: string): Promise<string> {
    const path = join(this.dir, DECISIONS);
    const id = nextId("D", parseEntries(await readFile(path, "utf8"), /^D\d+$/).map((e) => e.id));
    const fields: Record<string, string> = { Date: day(this.now()), By: prov, Refs: refs.join(", ") || "none" };
    if (note) fields.Note = note;
    await appendFile(path, `\n${renderEntry({ id, title, fields })}`);
    return id;
  }

  async #commit(op: string, file: string, id: string | undefined, prov: Provenance, summary: string, paths: string[] = [file]): Promise<void> {
    for (const p of paths) {
      if (CLAIM_GATED.has(p)) throw new LedgerError(`${p} is written only through the claim gate (invariant 5)`);
    }
    const changed = (await git(this.dir, ["status", "--porcelain"])).split("\n").filter(Boolean).map((l) => l.slice(3));
    if (op !== "create" && changed.some((f) => CLAIM_GATED.has(f))) {
      throw new LedgerError("logic/claims.md changed outside the claim gate; refusing to commit");
    }
    const entry: LedgerWrite = { ts: new Date(this.now()).toISOString(), op, file, ...(id ? { id } : {}), provenance: prov, summary };
    await appendFile(join(this.dir, LOG), `${JSON.stringify(entry)}\n`);
    await git(this.dir, ["add", "--", ...new Set([...paths, LOG])]);
    const who = isHumanProvenance(prov) ? [] : ["-c", `user.name=${AGENT_AUTHOR.name}`, "-c", `user.email=${AGENT_AUTHOR.email}`];
    await git(this.dir, [...who, "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", `ledger: ${summary}`, "--trailer", `Cairn-Provenance: ${prov}`]);
  }

  /** Path of a file relative to the project (for messages). */
  rel(path: string): string {
    return relative(this.dir, path);
  }
}
