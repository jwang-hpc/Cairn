// re literature check (M7): a branch's lit/ before it is merged. Every lit/refs.bib entry is re-verified against
// the services (resolutions.jsonl is provenance only: the agent can write it), must look exactly like what
// literature.resolve writes (plain-text values, known fields), and every citation in the notes must be in
// refs.bib. Per-paper notes (frontmatter `paper:`) are lit/notes/<citekey>.md and name the work their entry names.
import { type LiteratureService, normArxiv, normDoi, type PaperRecord, titleSimilarity } from "@cairn/executor";
import { parseDocument } from "yaml";

export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
  line: number;
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
    entries.push({ type: head[1]!.toLowerCase(), key: head[2]!, fields, line: lineAt(start) });
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

/** Sections a per-paper note has (DR-0009). */
export const NOTE_SECTIONS = ["Problem", "Method", "Setup", "Key numbers", "Limitations", "Artifact"] as const;

const FIELDS = new Set(["title", "author", "year", "journal", "booktitle", "doi", "eprint", "archiveprefix", "url"]);
const TYPES = new Set(["article", "inproceedings", "misc"]);
/** What bibValue() can produce: plain text with TeX specials escaped. Nothing else may carry a backslash or brace. */
const plainValue = (v: string) => !/[\\{}]/.test(v.replace(/\\[%&$#_]|\\\^\{\}|\\~\{\}/g, ""));
const surname = (a: string) =>
  (a.includes(",") ? a.split(",")[0]! : (a.trim().split(/\s+/).at(-1) ?? a))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

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
    let meta: { paper?: unknown } = {};
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
    const headings = new Set([...n.text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase()));
    const missing = NOTE_SECTIONS.filter((s) => !headings.has(s.toLowerCase()));
    if (missing.length) warn(n.path, `missing sections: ${missing.join(", ")}`);
  }
  for (const e of entries) if (!cited.has(e.key)) warn(`lit/refs.bib:${e.line} ${e.key}`, "cited by no note");

  return { items, references: entries.length, citations, notes: files.notes.length, ok: !items.some((x) => x.level === "fail") };
}
