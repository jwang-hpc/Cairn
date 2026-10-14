// re literature check (M7): a branch's lit/ before it is merged. Every lit/refs.bib entry is re-verified against
// the services (resolutions.jsonl is provenance only: the agent can write it), must look exactly like what
// literature.resolve writes (plain-text values, known fields), and every citation in the notes must be in
// refs.bib. Per-paper notes (frontmatter `paper:`) are lit/notes/<citekey>.md and name the work their entry names.
import { type LiteratureService, normArxiv, normDoi, type PaperRecord, surname as surnameOf, titleSimilarity } from "@cairn/executor";
import { parseDocument } from "yaml";

export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
  line: number;
  /** Offsets of the entry in the text: [start, end). */
  start: number;
  end: number;
}

/** BibTeX as literature.resolve writes it (and anything a hand might add): @type{key, field = {v} | "v" | 123, …}. */
export function parseBibtex(text: string): { entries: BibEntry[]; errors: string[] } {
  const entries: BibEntry[] = [];
  const errors: string[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  let i = 0;
  while ((i = text.indexOf("@", i)) !== -1) {
    const head = /^@(\w+)\s*\{\s*([^,\s{}]+)\s*,/.exec(text.slice(i));
    if (!head) {
      errors.push(`line ${lineAt(i)}: not a BibTeX entry`);
      i++;
      continue;
    }
    const start = i;
    let p = i + head[0].length;
    const fields: Record<string, string> = {};
    let closed = false;
    while (p < text.length) {
      const f = /^\s*(?:(\})|([A-Za-z][\w-]*)\s*=\s*)/.exec(text.slice(p));
      if (!f) break;
      p += f[0].length;
      if (f[1]) {
        closed = true;
        break;
      }
      let value: string;
      if (text[p] === "{") {
        let depth = 0;
        let q = p;
        for (; q < text.length; q++) {
          if (text[q] === "\\") {
            q++;
            continue;
          }
          if (text[q] === "{") depth++;
          else if (text[q] === "}" && --depth === 0) break;
        }
        if (q >= text.length) break;
        value = text.slice(p + 1, q);
        p = q + 1;
      } else if (text[p] === '"') {
        const q = text.indexOf('"', p + 1);
        if (q === -1) break;
        value = text.slice(p + 1, q);
        p = q + 1;
      } else {
        const m = /^[\w.-]+/.exec(text.slice(p));
        if (!m) break;
        value = m[0];
        p += m[0].length;
      }
      fields[f[2]!.toLowerCase()] = value;
      const sep = /^\s*,?/.exec(text.slice(p))!;
      p += sep[0].length;
    }
    if (!closed) {
      errors.push(`line ${lineAt(start)}: entry ${head[2]} is malformed`);
      i = start + 1;
      continue;
    }
    entries.push({ type: head[1]!.toLowerCase(), key: head[2]!, fields, line: lineAt(start), start, end: p });
    i = p;
  }
  return { entries, errors };
}

/** Citation keys in Markdown: pandoc [@a; @b, p. 3] and LaTeX \cite{a,b}. */
export function citationsIn(md: string): string[] {
  const keys: string[] = [];
  for (const g of md.matchAll(/\[[^[\]]*@[^[\]]*\]/g)) for (const k of g[0].matchAll(/(?:^|[\s;[(-])@([A-Za-z0-9_:.-]*[A-Za-z0-9])/g)) keys.push(k[1]!);
  for (const c of md.matchAll(/\\cite[pt]?\*?\{([^}]*)\}/g)) for (const k of c[1]!.split(",")) if (k.trim()) keys.push(k.trim());
  return keys;
}

/** A paper note's relevance score: the agent's judgement of the paper against the project's problem, 0-10. */
export const isRelevance = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10;

/** Sections a per-paper note has (DR-0009). */
export const NOTE_SECTIONS = ["Problem", "Method", "Setup", "Key numbers", "Limitations", "Artifact"] as const;

const FIELDS = new Set(["title", "author", "year", "journal", "booktitle", "doi", "eprint", "archiveprefix", "url"]);
const TYPES = new Set(["article", "inproceedings", "misc"]);
/** What bibValue() can produce: plain text with TeX specials escaped. Nothing else may carry a backslash or brace. */
const plainValue = (v: string) => !/[\\{}]/.test(v.replace(/\\[%&$#_]|\\\^\{\}|\\~\{\}/g, ""));
const surname = surnameOf;
const titleOf = (e: BibEntry) => (e.fields.title ?? "").replace(/^\{([\s\S]*)\}$/, "$1");
const firstAuthor = (e: BibEntry) => e.fields.author?.split(/\s+and\s+/)[0];

/**
 * Preprint/publication pairs in one refs.bib: an arXiv-only entry and a DOI entry for the same paper (the same eprint,
 * or the same title and first author; see samePaper). They are one reference, the publication's.
 */
export function preprintPairs(entries: BibEntry[]): { preprint: BibEntry; published: BibEntry }[] {
  const pairs: { preprint: BibEntry; published: BibEntry }[] = [];
  for (const pre of entries.filter((e) => e.fields.eprint && !e.fields.doi)) {
    const a = normArxiv(pre.fields.eprint);
    const pub = entries.find((d) => {
      if (!d.fields.doi || d === pre) return false;
      if (a && normArxiv(d.fields.eprint) === a) return true;
      const fa = firstAuthor(pre);
      const fd = firstAuthor(d);
      return titleSimilarity(titleOf(pre), titleOf(d)) >= 0.9 && (!fa || !fd || surname(fa) === surname(fd));
    });
    if (pub) pairs.push({ preprint: pre, published: pub });
  }
  return pairs;
}

export interface LitFiles {
  refs: string;
  /** lit/notes/*.md and, if present, logic/related_work.md. */
  notes: { path: string; text: string }[];
  resolutions?: string;
}

export interface CheckItem {
  level: "fail" | "warn";
  where: string;
  message: string;
}

export interface CheckReport {
  items: CheckItem[];
  references: number;
  citations: number;
  notes: number;
  ok: boolean;
}

export async function checkLiterature(files: LitFiles, lit: LiteratureService): Promise<CheckReport> {
  const items: CheckItem[] = [];
  const fail = (where: string, message: string) => items.push({ level: "fail", where, message });
  const warn = (where: string, message: string) => items.push({ level: "warn", where, message });

  const { entries, errors } = parseBibtex(files.refs);
  for (const e of errors) fail("lit/refs.bib", e);
  const byKey = new Map<string, BibEntry>();
  for (const e of entries) {
    if (byKey.has(e.key)) fail(`lit/refs.bib:${e.line}`, `duplicate citekey ${e.key}`);
    byKey.set(e.key, e);
  }
  const logged = new Set<string>();
  for (const line of (files.resolutions ?? "").split("\n")) {
    try {
      const k = (JSON.parse(line) as { key?: unknown }).key;
      if (typeof k === "string") logged.add(k);
    } catch {
      // not a log line
    }
  }

  // Each entry: shape first (no network for a malformed entry), then every id it carries re-resolved.
  for (const e of entries) {
    const where = `lit/refs.bib:${e.line} ${e.key}`;
    const shape = [
      !/^[a-z0-9]{1,65}$/.test(e.key) ? `citekey must be lowercase letters and digits` : "",
      !TYPES.has(e.type) ? `@${e.type} is not a type literature.resolve writes` : "",
      ...Object.keys(e.fields).filter((f) => !FIELDS.has(f)).map((f) => `field ${f} is not one literature.resolve writes`),
      ...Object.entries(e.fields)
        .filter(([f, v]) => !plainValue(f === "title" ? v.replace(/^\{([\s\S]*)\}$/, "$1") : v))
        .map(([f]) => `field ${f} holds LaTeX commands or braces`),
      !e.fields.title ? "no title" : "",
      !e.fields.doi && !e.fields.eprint ? "neither a doi nor an arXiv eprint" : "",
    ].filter(Boolean);
    if (shape.length) {
      fail(where, `${shape.join("; ")}. Re-add it with literature.resolve (never by hand)`);
      continue;
    }
    const ids: { doi?: string; arxiv?: string } = {};
    if (e.fields.doi) {
      const d = normDoi(e.fields.doi);
      if (!d) fail(where, `doi ${e.fields.doi} is not a DOI`);
      else ids.doi = d;
    }
    if (e.fields.eprint) {
      const a = normArxiv(e.fields.eprint);
      if (!a) fail(where, `eprint ${e.fields.eprint} is not an arXiv id`);
      else ids.arxiv = a;
    }
    if (!ids.doi && !ids.arxiv) continue;
    let primary: PaperRecord | undefined;
    for (const [kind, id] of [["doi", ids.doi], ["arxiv", ids.arxiv]] as const) {
      if (!id) continue;
      let r;
      try {
        r = await lit.resolve(kind === "doi" ? { doi: id } : { arxiv: id });
      } catch (err) {
        fail(where, `could not re-verify ${kind} ${id}: ${(err as Error).message}`);
        continue;
      }
      if (r.status !== "resolved" || !r.record) {
        fail(where, `${kind} ${id} does not resolve (${r.checks.at(-1) ?? r.status})`);
        continue;
      }
      const title = e.fields.title!.replace(/^\{([\s\S]*)\}$/, "$1");
      if (titleSimilarity(title, r.record.title) < 0.9) fail(where, `title does not match ${kind} ${id} ("${r.record.title}")`);
      primary ??= r.record;
    }
    if (!primary) continue;
    if (e.fields.year && primary.year && Number(e.fields.year) !== primary.year) fail(where, `year ${e.fields.year}, but the record says ${primary.year}; re-resolve it`);
    const first = e.fields.author?.split(/\s+and\s+/)[0];
    if (first && primary.authors[0] && surname(first) !== surname(primary.authors[0])) fail(where, `first author ${first}, but the record says ${primary.authors[0]}`);
    if (!logged.has(e.key)) warn(where, "verified, but not in lit/resolutions.jsonl (not added through literature.resolve)");
  }

  for (const { preprint, published } of preprintPairs(entries)) {
    warn(`lit/refs.bib:${preprint.line} ${preprint.key}`, `the arXiv preprint of ${published.key} (same paper): cite ${published.key}; re literature accept merges them`);
  }

  // Notes: every citation in refs.bib; per-paper notes named after their entry and naming the same work.
  let citations = 0;
  const cited = new Set<string>();
  for (const n of files.notes) {
    for (const k of citationsIn(n.text)) {
      citations++;
      cited.add(k);
      if (!byKey.has(k)) fail(n.path, `cites ${k}, which is not in lit/refs.bib (resolve it first)`);
    }
    const front = /^---\n([\s\S]*?)\n---\n/.exec(n.text)?.[1];
    let meta: { paper?: unknown; relevance?: unknown } = {};
    try {
      meta = (front ? (parseDocument(front).toJS() as typeof meta | null) : null) ?? {};
    } catch {
      fail(n.path, "frontmatter is not YAML");
    }
    if (meta.paper === undefined) continue;
    const key = /^lit\/notes\/([a-z0-9]+)\.md$/.exec(n.path)?.[1];
    const entry = key ? byKey.get(key) : undefined;
    if (!entry) {
      fail(n.path, "a paper note must be lit/notes/<citekey>.md for a key in lit/refs.bib");
      continue;
    }
    cited.add(entry.key);
    const id = String(meta.paper);
    const doi = /^doi:/i.test(id) ? normDoi(id.slice(4)) : undefined;
    const arxiv = /^arxiv:/i.test(id) ? normArxiv(id.slice(6)) : undefined;
    if (!(doi && normDoi(entry.fields.doi) === doi) && !(arxiv && normArxiv(entry.fields.eprint) === arxiv)) {
      fail(n.path, `paper: ${id} is not the work ${entry.key} names in lit/refs.bib`);
    }
    if (meta.relevance === undefined) warn(n.path, "no relevance score (relevance: 0-10 in the frontmatter)");
    else if (!isRelevance(meta.relevance)) fail(n.path, `relevance must be an integer from 0 to 10, not ${JSON.stringify(meta.relevance)}`);
    const headings = new Set([...n.text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase()));
    const missing = NOTE_SECTIONS.filter((s) => !headings.has(s.toLowerCase()));
    if (missing.length) warn(n.path, `missing sections: ${missing.join(", ")}`);
  }
  for (const e of entries) if (!cited.has(e.key)) warn(`lit/refs.bib:${e.line} ${e.key}`, "cited by no note");

  return { items, references: entries.length, citations, notes: files.notes.length, ok: !items.some((x) => x.level === "fail") };
}

export interface PaperNote {
  path: string;
  key: string;
  paper: string;
  relevance?: number;
  title?: string;
  year?: number;
}

/** Per-paper notes (frontmatter `paper:`), most relevant first; unscored notes last. */
export function paperNotes(notes: LitFiles["notes"]): PaperNote[] {
  const out: PaperNote[] = [];
  for (const n of notes) {
    const key = /^lit\/notes\/([a-z0-9]+)\.md$/.exec(n.path)?.[1];
    const front = /^---\n([\s\S]*?)\n---\n/.exec(n.text)?.[1];
    if (!key || !front) continue;
    let meta: Record<string, unknown>;
    try {
      meta = (parseDocument(front).toJS() as Record<string, unknown> | null) ?? {};
    } catch {
      continue;
    }
    if (meta.paper === undefined) continue;
    out.push({
      path: n.path,
      key,
      paper: String(meta.paper),
      ...(isRelevance(meta.relevance) ? { relevance: meta.relevance } : {}),
      ...(typeof meta.title === "string" ? { title: meta.title } : {}),
      ...(typeof meta.year === "number" ? { year: meta.year } : {}),
    });
  }
  return out.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || a.key.localeCompare(b.key));
}

export interface PreprintMerge {
  from: string;
  into: string;
  /** Citations rewritten from [@from] to [@into]. */
  citations: number;
  /** What happened to lit/notes/<from>.md. */
  note: "renamed" | "dropped" | "none";
}

const citeOf = (key: string) => new RegExp(`(^|[\\s;[(-])@${key}(?![A-Za-z0-9_]|[:.-][A-Za-z0-9])`, "g");

/**
 * Merges each preprint/publication pair into the publication (the user's rule: one reference per paper, for
 * submission too): the preprint's entry goes, the publication keeps the arXiv id as its eprint, citations of the
 * preprint's key are rewritten, and the preprint's note becomes the publication's (or is dropped if the publication
 * has one). Returns the new files and the note paths that no longer exist.
 */
export function mergePreprints(files: LitFiles, now = new Date()): { files: LitFiles; merges: PreprintMerge[]; removed: string[] } {
  const { entries } = parseBibtex(files.refs);
  const pairs = preprintPairs(entries);
  if (pairs.length === 0) return { files, merges: [], removed: [] };
  // refs.bib: edit from the end so earlier offsets stay valid.
  const edits: { start: number; end: number; text: string }[] = [];
  for (const { preprint, published } of pairs) {
    const end = files.refs.slice(preprint.end).match(/^\s*/)![0].length + preprint.end;
    edits.push({ start: preprint.start, end, text: "" });
    if (!published.fields.eprint) {
      const body = files.refs.slice(published.start, published.end);
      const close = body.lastIndexOf("}");
      const before = body.slice(0, close).replace(/[\s,]*$/, "");
      edits.push({ start: published.start, end: published.end, text: `${before},\n  eprint = {${normArxiv(preprint.fields.eprint)}},\n  archivePrefix = {arXiv}\n}` });
    }
  }
  let refs = files.refs;
  for (const e of edits.sort((a, b) => b.start - a.start)) refs = refs.slice(0, e.start) + e.text + refs.slice(e.end);

  const merges: PreprintMerge[] = [];
  const removed: string[] = [];
  let notes = files.notes.map((n) => ({ ...n }));
  for (const { preprint, published } of pairs) {
    let citations = 0;
    for (const n of notes) {
      n.text = n.text.replace(citeOf(preprint.key), (_m, lead: string) => (citations++, `${lead}@${published.key}`));
      n.text = n.text.replace(/\\cite([pt]?\*?)\{([^}]*)\}/g, (_m, v: string, keys: string) =>
        `\\cite${v}{${keys.split(",").map((k) => (k.trim() === preprint.key ? (citations++, published.key) : k)).join(",")}}`,
      );
    }
    const from = `lit/notes/${preprint.key}.md`;
    const into = `lit/notes/${published.key}.md`;
    let note: PreprintMerge["note"] = "none";
    if (notes.some((n) => n.path === from)) {
      if (notes.some((n) => n.path === into)) {
        notes = notes.filter((n) => n.path !== from);
        note = "dropped";
      } else {
        notes = notes.map((n) => (n.path === from ? { path: into, text: n.text.replace(/^paper:.*$/m, `paper: doi:${normDoi(published.fields.doi)}`) } : n));
        note = "renamed";
      }
      removed.push(from);
    }
    merges.push({ from: preprint.key, into: published.key, citations, note });
  }
  const log = merges.map((m) => JSON.stringify({ at: now.toISOString(), merged: m.from, into: m.into, by: "re literature accept" })).join("\n");
  const resolutions = `${files.resolutions ?? ""}${files.resolutions && !files.resolutions.endsWith("\n") ? "\n" : ""}${log}\n`;
  return { files: { refs, notes, resolutions }, merges, removed };
}
