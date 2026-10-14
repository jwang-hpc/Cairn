// `re literature ...` (M7): search, fetch, resolve, and the settings the literature proxy needs — the contact
// address OpenAlex and Crossref ask API users for ("polite pool", in engine.yaml so each user sets their own) and an
// optional Semantic Scholar key (secrets folder, host only).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { LIT_SOURCES, type LitSource, type PaperRecord, type Resolution } from "@cairn/executor";
import { git, gitBlob } from "@cairn/launcher";
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import type { Ledger } from "../ledger/ledger.js";
import { provenance as prov } from "@cairn/shared";
import { readUsage } from "../events/log.js";
import { checkLiterature, type CheckReport, type LitFiles } from "./check.js";
import { type LiteratureDeps, openLiteratureService, setLiteratureKey } from "./literature.js";

export const LITERATURE_COMMANDS = ["literature"] as const;
export const LITERATURE_OPTIONS = {
  clear: { type: "boolean" },
  sources: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  limit: { type: "string" },
  year: { type: "string" },
  author: { type: "string" },
} as const;
export const LITERATURE_USAGE = `literature commands (Semantic Scholar, OpenAlex, arXiv, Crossref; doi.org checks DOIs):
  literature search <query...> [--sources s2,openalex,arxiv,crossref] [--from Y] [--to Y] [--limit N]
  literature fetch <doi:… | arxiv:… | s2:… | openalex:W…>
  literature resolve <doi | arxiv:id>  |  literature resolve --title T [--year Y] [--author A]
                                           verify a citation and print its BibTeX (no BibTeX unless verified)
  literature contact [<email> | --clear]   the contact address sent to OpenAlex and Crossref (their "polite
                                           pool"; never sent to a model); stored in engine.yaml
  literature key s2 [--clear]              store an optional Semantic Scholar API key (secrets folder, host only)
  literature check [<branch>]              before merging a branch: every lit/refs.bib entry re-verified, every
                                           citation in lit/notes/ (and logic/related_work.md) in refs.bib
  literature accept <branch>               check, then write that branch's lit/ into the ledger as one commit
                                           tagged ai-suggested(<the run's model>, <effort>)`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Set or clear literature.contact_email in <config>/engine.yaml, keeping the file's comments and layout. */
export async function setContactEmail(configDir: string, email: string | undefined): Promise<void> {
  if (email !== undefined && (!EMAIL.test(email) || email.length > 254)) throw new Error(`not an email address: ${email}`);
  const path = join(configDir, "engine.yaml");
  const doc = parseDocument(await readFile(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path}: ${doc.errors[0]!.message}`);
  if (email === undefined) {
    doc.deleteIn(["literature", "contact_email"]);
    const lit = doc.getIn(["literature"]) as { items?: unknown[] } | undefined;
    if (lit && Array.isArray(lit.items) && lit.items.length === 0) doc.deleteIn(["literature"]);
  } else {
    doc.setIn(["literature", "contact_email"], email);
  }
  await writeFile(path, doc.toString());
}

const line = (r: PaperRecord) =>
  `${String(r.year ?? "    ")}  ${(r.ids.doi ? `doi:${r.ids.doi}` : r.ids.arxiv ? `arxiv:${r.ids.arxiv}` : r.ids.s2 ? `s2:${r.ids.s2}` : r.ids.openalex ? `openalex:${r.ids.openalex}` : "-").padEnd(40)} ${r.title.slice(0, 90)}  [${r.sources.join(",")}]`;
const num = (s: unknown) => (typeof s === "string" && /^\d{1,4}$/.test(s) ? Number(s) : undefined);

function printResolution(r: Resolution, io: Io): void {
  io.out(`${r.status}${r.citekey ? `: ${r.citekey}` : ""}`);
  for (const c of r.checks) io.out(`  check: ${c}`);
  if (r.bibtex) io.out(r.bibtex.trimEnd());
  for (const c of r.candidates ?? []) io.out(`  candidate: ${line(c)}`);
}

export async function runLiteratureCommand(
  engine: Engine,
  args: string[],
  v: Values,
  io: Io & { ask?: (q: string, secret: boolean) => Promise<string> },
  deps: LiteratureDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [sub, value] = args;
  if (!["contact", "search", "fetch", "resolve", "key", "check", "accept"].includes(sub ?? "")) {
    io.err(`re literature: unknown subcommand '${sub ?? ""}'\n${LITERATURE_USAGE}`);
    return 2;
  }
  try {
    if (sub === "search") {
      const query = args.slice(1).join(" ").trim();
      if (!query) throw new Error("usage: re literature search <query...>");
      const sources = typeof v.sources === "string" ? (v.sources.split(",").map((s) => s.trim()) as LitSource[]) : undefined;
      for (const s of sources ?? []) if (!(LIT_SOURCES as readonly string[]).includes(s)) throw new Error(`unknown source ${s} (have ${LIT_SOURCES.join(", ")})`);
      const yearFrom = num(v.from);
      const yearTo = num(v.to);
      const limit = num(v.limit);
      const r = await (await openLiteratureService(engine, deps)).search(query, { ...(sources ? { sources } : {}), ...(yearFrom ? { yearFrom } : {}), ...(yearTo ? { yearTo } : {}), ...(limit ? { limit } : {}) });
      io.out(`sources: ${r.sources.map((s) => `${s.source} ${s.status}${s.count ? ` (${s.count})` : ""}`).join(", ")}`);
      for (const s of r.sources.filter((x) => x.detail)) io.err(`  ${s.source}: ${s.detail}`);
      if (r.records.length === 0) io.out("(no results)");
      for (const rec of r.records) io.out(line(rec));
      return 0;
    }
    if (sub === "fetch") {
      if (!value) throw new Error("usage: re literature fetch <id>");
      const { record, sources } = await (await openLiteratureService(engine, deps)).fetch(value);
      io.out(line(record));
      io.out(`authors: ${record.authors.join("; ") || "-"}`);
      if (record.venue) io.out(`venue:   ${record.venue}`);
      io.out(`ids:     ${Object.entries(record.ids).map(([k, x]) => `${k}:${x}`).join("  ")}`);
      if (record.abstract) io.out(`abstract (external text): ${record.abstract}`);
      io.err(`sources: ${sources.map((s) => `${s.source} ${s.status}`).join(", ")}`);
      return 0;
    }
    if (sub === "resolve") {
      const svc = await openLiteratureService(engine, deps);
      const year = num(v.year);
      const r =
        typeof v.title === "string"
          ? await svc.resolve({ title: v.title, ...(year ? { year } : {}), ...(typeof v.author === "string" ? { author: v.author } : {}) })
          : value
            ? await svc.resolve(/^arxiv:/i.test(value) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(value) ? { arxiv: value } : { doi: value })
            : undefined;
      if (!r) throw new Error("usage: re literature resolve <doi | arxiv:id> | --title T [--year Y] [--author A]");
      printResolution(r, io);
      return r.status === "resolved" ? 0 : 1;
    }
    if (sub === "check" || sub === "accept") {
      const ledger = await openCurrentProject(engine, v, env);
      const rev = value ?? (sub === "check" ? "HEAD" : "");
      if (!rev) throw new Error("usage: re literature accept <branch>");
      const report = await checkLiterature(await litFiles(ledger, rev), await openLiteratureService(engine, deps));
      printReport(report, `${ledger.name}@${rev}`, io);
      if (!report.ok) {
        if (sub === "accept") io.out("nothing accepted");
        return 1;
      }
      if (sub === "check") return 0;
      const done = await acceptLiterature(engine, ledger, rev, report);
      io.out(done.files.length ? `accepted into ${ledger.name}: ${done.files.join(", ")} (${done.provenance})` : "nothing new to accept");
      for (const s of done.skipped) io.err(`not accepted (check doesn't read it): ${s}`);
      return 0;
    }
    if (sub === "key") {
      if (value !== "s2") throw new Error("usage: re literature key s2 [--clear]");
      if (v.clear) {
        await setLiteratureKey(engine.paths.home, "s2", undefined);
        io.out("Semantic Scholar key removed");
        return 0;
      }
      if (!io.ask) throw new Error("re literature key needs an interactive terminal");
      await setLiteratureKey(engine.paths.home, "s2", (await io.ask("Semantic Scholar API key (https://www.semanticscholar.org/product/api):", true)).trim());
      io.out("Semantic Scholar key stored in the engine's secrets folder (host only)");
      return 0;
    }
    if (v.clear) {
      await setContactEmail(engine.paths.configDir, undefined);
      io.out("contact address cleared: OpenAlex and Crossref will be queried anonymously (slower pool)");
    } else if (value) {
      await setContactEmail(engine.paths.configDir, value);
      io.out(`contact address set: ${value} (sent only to OpenAlex and Crossref)`);
    } else {
      const current = engine.config.engine.literature?.contact_email;
      io.out(current ? `contact address: ${current} (sent only to OpenAlex and Crossref)` : "no contact address: OpenAlex and Crossref are queried anonymously (set one with re literature contact <email>)");
    }
    return 0;
  } catch (e) {
    io.err(`re literature: ${(e as Error).message}`);
    return 1;
  }
}

const MAX_NOTES = 500;

/** lit/ as committed at `rev` of the project (a branch an agent committed, or HEAD). */
export async function litFiles(ledger: Ledger, rev: string): Promise<LitFiles> {
  if (!/^[\w./-]{1,200}$/.test(rev) || rev.startsWith("-")) throw new Error(`not a branch or revision: ${rev}`);
  const commit = (await git(ledger.dir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
  const read = (path: string) => gitBlob(ledger.dir, commit, path).then((b) => b.toString("utf8"), () => undefined);
  const listed = (await git(ledger.dir, ["ls-tree", "-r", "--name-only", commit, "--", "lit/notes/"])).split("\n").filter((p) => p.endsWith(".md"));
  if (listed.length > MAX_NOTES) throw new Error(`${listed.length} notes is more than check reads (${MAX_NOTES})`);
  const notes: LitFiles["notes"] = [];
  for (const path of [...listed, "logic/related_work.md"]) {
    const text = await read(path);
    if (text !== undefined) notes.push({ path, text });
  }
  const resolutions = await read("lit/resolutions.jsonl");
  return { refs: (await read("lit/refs.bib")) ?? "", notes, ...(resolutions !== undefined ? { resolutions } : {}) };
}

function printReport(report: CheckReport, what: string, io: Io): void {
  for (const i of report.items) (i.level === "fail" ? io.out : io.err)(`${i.level === "fail" ? "FAIL" : "warn"}  ${i.where}: ${i.message}`);
  const failures = report.items.filter((i) => i.level === "fail").length;
  io.out(`${report.ok ? "ok" : "FAILED"}: ${what}: ${report.references} references, ${report.citations} citations in ${report.notes} note files${report.ok ? "" : `, ${failures} failures`}`);
}

const MAX_FILE = 1 << 20;
/** What `check` reads, and so all that `accept` copies. */
const ACCEPTED = (p: string) => p === "lit/refs.bib" || p === "lit/resolutions.jsonl" || /^lit\/notes\/[^/]+\.md$/.test(p);

/**
 * Writes a checked branch's lit/ into the ledger: one commit tagged ai-suggested(<model>, <effort>) of the run that
 * made the branch (from the event log, by the commit's Cairn-Run trailer). Refused when lit/ changed in the project
 * since the branch started, or when the branch deletes or symlinks anything under lit/: accept only adds and updates.
 */
export async function acceptLiterature(engine: Engine, ledger: Ledger, rev: string, _report: CheckReport): Promise<{ files: string[]; skipped: string[]; provenance: string }> {
  const commit = (await git(ledger.dir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
  const base = (await git(ledger.dir, ["merge-base", "HEAD", commit])).trim();
  const moved = (await git(ledger.dir, ["diff", "--name-only", base, "HEAD", "--", "lit/"])).trim();
  if (moved) throw new Error(`lit/ changed in ${ledger.name} since ${rev} started (${moved.split("\n").join(", ")}); run the literature task again from the current state`);
  const deleted = (await git(ledger.dir, ["diff", "--name-only", "--diff-filter=D", base, commit, "--", "lit/"])).trim();
  if (deleted) throw new Error(`${rev} deletes ${deleted.split("\n").join(", ")}; accept only adds and updates`);
  const run = (await git(ledger.dir, ["log", "-1", "--format=%(trailers:key=Cairn-Run,valueonly)", commit])).trim();
  const usage = run ? (await readUsage(engine.paths.home)).records.find((r) => r.run === run) : undefined;
  if (!usage) throw new Error(`can't tell which model wrote ${rev}: ${run ? `no usage recorded for run ${run}` : "its last commit has no Cairn-Run trailer"}`);
  const provenance = prov.aiSuggested(usage.model, usage.effort);

  const files: { path: string; content: Buffer }[] = [];
  const skipped: string[] = [];
  const changed = (await git(ledger.dir, ["diff", "--name-only", "--diff-filter=AM", base, commit, "--", "lit/"])).split("\n").filter(Boolean);
  const modes = new Map(
    (await git(ledger.dir, ["ls-tree", "-r", commit, "--", "lit/"])).split("\n").filter(Boolean).map((l) => {
      const [meta, path] = l.split("\t");
      return [path!, meta!.split(" ")[0]!] as const;
    }),
  );
  for (const path of changed) {
    if (!ACCEPTED(path)) {
      skipped.push(path);
      continue;
    }
    if (modes.get(path) !== "100644" && modes.get(path) !== "100755") throw new Error(`${path} on ${rev} is not a regular file`);
    const content = await gitBlob(ledger.dir, commit, path);
    if (content.length > MAX_FILE) throw new Error(`${path} on ${rev} is larger than ${MAX_FILE} bytes`);
    files.push({ path, content });
  }
  if (files.length) await ledger.writeArtifacts(files, provenance, `literature from ${rev} (re literature check passed)`, "literature");
  return { files: files.map((f) => f.path), skipped, provenance };
}
