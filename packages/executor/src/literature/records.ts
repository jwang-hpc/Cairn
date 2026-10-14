// Literature records (M7): one normalized shape for every source, identifier normalization, dedupe, and BibTeX that
// can't carry LaTeX commands. Everything here comes from external services: it is data, never instructions.

export const LIT_SOURCES = ["s2", "openalex", "arxiv", "crossref"] as const;
export type LitSource = (typeof LIT_SOURCES)[number];

export interface PaperIds {
  doi?: string;
  arxiv?: string;
  s2?: string;
  openalex?: string;
  dblp?: string;
}

export interface PaperRecord {
  ids: PaperIds;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** Truncated; untrusted text. */
  abstract?: string;
  citations?: number;
  /** "journal-article", "proceedings-article", "preprint", ... */
  kind?: string;
  sources: LitSource[];
}

export const ABSTRACT_MAX = 1500;

/** "https://doi.org/10.1109/X" -> "10.1109/x"; undefined if not a DOI. DOIs are case-insensitive. */
export function normDoi(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const d = s.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "").toLowerCase();
  return /^10\.\d{4,9}\/[^\s"<>]+$/.test(d) ? d : undefined;
}

/** "arXiv:2304.11768v2", "http://arxiv.org/abs/2304.11768v2" -> "2304.11768"; old style "hep-th/9901001". */
export function normArxiv(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const a = s.trim().replace(/^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:)/i, "").replace(/\.pdf$/, "").replace(/v\d+$/, "");
  return /^\d{4}\.\d{4,5}$/.test(a) || /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/.test(a) ? a : undefined;
}

/** arXiv's DataCite DOI (10.48550/arXiv.2304.11768) names an arXiv id. */
export const arxivFromDoi = (doi: string | undefined) => (doi ? normArxiv(/^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1]) : undefined);

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Plain text from provider markup: HTML/JATS tags dropped, entities decoded, whitespace collapsed. */
export function plain(s: string | undefined | null): string {
  if (!s) return "";
  return decodeEntities(s.replace(/<[^>]{0,200}>/g, " ")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " ";
  });
}

export const normTitle = (t: string) =>
  plain(t)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Word-set overlap of two titles (Jaccard), 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normTitle(a).split(" ").filter(Boolean));
  const B = new Set(normTitle(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** Dedupe key: DOI > arXiv id > Semantic Scholar id > title + year. */
export function recordKey(r: PaperRecord): string {
  if (r.ids.doi) return `doi:${r.ids.doi}`;
  if (r.ids.arxiv) return `arxiv:${r.ids.arxiv}`;
  if (r.ids.s2) return `s2:${r.ids.s2}`;
  return `title:${normTitle(r.title)}|${r.year ?? ""}`;
}

/** Merge records describing the same work; keeps every id, the fullest metadata, and every source that found it. */
export function mergeRecords(records: PaperRecord[]): PaperRecord[] {
  const out: PaperRecord[] = [];
  for (const r of records) {
    // Different DOIs (or arXiv ids) are different works, whatever their titles say.
    const conflict = (o: PaperRecord) => (r.ids.doi && o.ids.doi && r.ids.doi !== o.ids.doi) || (r.ids.arxiv && o.ids.arxiv && r.ids.arxiv !== o.ids.arxiv);
    const same = out.find(
      (o) =>
        (r.ids.doi && o.ids.doi === r.ids.doi) ||
        (r.ids.arxiv && o.ids.arxiv === r.ids.arxiv) ||
        (r.ids.s2 && o.ids.s2 === r.ids.s2) ||
        (!conflict(o) && normTitle(o.title) === normTitle(r.title) && (o.year === undefined || r.year === undefined || o.year === r.year)),
    );
    if (!same) {
      out.push({ ...r, ids: { ...r.ids }, authors: [...r.authors], sources: [...r.sources] });
      continue;
    }
    same.ids = { ...r.ids, ...same.ids };
    if (same.authors.length === 0) same.authors = [...r.authors];
    if (same.year === undefined && r.year !== undefined) same.year = r.year;
    if (same.venue === undefined && r.venue !== undefined) same.venue = r.venue;
    if (same.kind === undefined && r.kind !== undefined) same.kind = r.kind;
    if (r.abstract !== undefined && r.abstract.length > (same.abstract?.length ?? 0)) same.abstract = r.abstract;
    if (r.citations !== undefined && r.citations > (same.citations ?? -1)) same.citations = r.citations;
    for (const s of r.sources) if (!same.sources.includes(s)) same.sources.push(s);
  }
  return out;
}

// ---------- BibTeX ----------

/** ASCII-folded lowercase letters: a citekey part. */
const keyPart = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const STOP = new Set(["a", "an", "the", "on", "of", "for", "in", "to", "and", "with", "towards", "toward", "via", "is", "are"]);

/** First author's surname + year + first significant title word, e.g. liang2023sz3. Only [a-z0-9]. */
export function citekey(r: PaperRecord): string {
  const first = r.authors[0] ?? "anon";
  const surname = first.includes(",") ? first.split(",")[0]! : (first.trim().split(/\s+/).at(-1) ?? first);
  const word = normTitle(r.title).split(" ").find((w) => w.length > 2 && !STOP.has(w)) ?? "work";
  return `${keyPart(surname) || "anon"}${r.year ?? "nd"}${keyPart(word)}`.slice(0, 64);
}

/**
 * A BibTeX field value from untrusted text: plain text only. Backslashes are dropped (no \input, \write18, or any
 * other command can survive), braces are dropped, and TeX specials are escaped.
 */
export function bibValue(s: string): string {
  return plain(s)
    .replace(/[\\{}]/g, "")
    .replace(/([%&$#_])/g, "\\$1")
    .replace(/\^/g, "\\^{}")
    .replace(/~/g, "\\~{}");
}

export function toBibtex(r: PaperRecord, key: string): string {
  if (!/^[a-z0-9]+$/.test(key)) throw new Error(`bad citekey ${key}`);
  const kind = r.kind ?? "";
  const type = r.ids.arxiv && !r.ids.doi?.startsWith("10.") ? "misc" : /journal/.test(kind) ? "article" : /proceedings|conference/.test(kind) ? "inproceedings" : r.ids.arxiv ? "misc" : "article";
  const fields: [string, string | undefined][] = [
    ["title", `{${bibValue(r.title)}}`],
    ["author", r.authors.length ? r.authors.map((a) => bibValue(a)).join(" and ") : undefined],
    ["year", r.year ? String(r.year) : undefined],
    [type === "inproceedings" ? "booktitle" : "journal", type === "misc" ? undefined : r.venue ? bibValue(r.venue) : undefined],
    ["doi", r.ids.doi && !arxivFromDoi(r.ids.doi) ? r.ids.doi.replace(/[^A-Za-z0-9._;()/:<>-]/g, "") : undefined],
    ["eprint", r.ids.arxiv],
    ["archivePrefix", r.ids.arxiv ? "arXiv" : undefined],
    ["url", r.ids.doi && !arxivFromDoi(r.ids.doi) ? `https://doi.org/${encodeURI(r.ids.doi)}` : r.ids.arxiv ? `https://arxiv.org/abs/${r.ids.arxiv}` : undefined],
  ];
  return `@${type}{${key},\n${fields
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(",\n")}\n}\n`;
}
