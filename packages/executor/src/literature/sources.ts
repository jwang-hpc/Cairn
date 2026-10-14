// Source adapters (M7): Semantic Scholar, OpenAlex, arXiv, Crossref, and doi.org's handle API. Each turns one API's
// response into PaperRecords. URLs are built only from fixed bases and validated ids or query strings.
import { type LitHttp, LitError } from "./net.js";
import { ABSTRACT_MAX, clip, decodeEntities, type LitSource, normArxiv, normDoi, type PaperRecord, plain } from "./records.js";

export interface SearchOptions {
  limit: number;
  yearFrom?: number;
  yearTo?: number;
}

export interface SourceAdapter {
  source: LitSource;
  search(query: string, o: SearchOptions): Promise<PaperRecord[]>;
}

const json = <T>(body: string, what: string): T => {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new LitError(`${what}: not JSON`, "error");
  }
};
const yearRange = (o: SearchOptions) => (o.yearFrom || o.yearTo ? [o.yearFrom ?? 1900, o.yearTo ?? new Date().getFullYear()] : undefined);

// ---------- Semantic Scholar ----------

const S2 = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "title,year,authors,venue,externalIds,abstract,citationCount,publicationTypes";

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number;
  venue?: string;
  abstract?: string;
  citationCount?: number;
  publicationTypes?: string[] | null;
  authors?: { name?: string }[];
  externalIds?: { DOI?: string; ArXiv?: string; DBLP?: string } | null;
}

export function fromS2(p: S2Paper): PaperRecord | undefined {
  if (!p.title) return undefined;
  const doi = normDoi(p.externalIds?.DOI);
  const arxiv = normArxiv(p.externalIds?.ArXiv);
  return {
    ids: { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(p.paperId ? { s2: p.paperId } : {}), ...(p.externalIds?.DBLP ? { dblp: p.externalIds.DBLP } : {}) },
    title: plain(p.title),
    authors: (p.authors ?? []).map((a) => plain(a.name)).filter(Boolean),
    ...(p.year ? { year: p.year } : {}),
    ...(p.venue ? { venue: plain(p.venue) } : {}),
    ...(p.abstract ? { abstract: clip(plain(p.abstract), ABSTRACT_MAX) } : {}),
    ...(p.citationCount !== undefined ? { citations: p.citationCount } : {}),
    ...(p.publicationTypes?.includes("Conference") ? { kind: "proceedings-article" } : p.publicationTypes?.includes("JournalArticle") ? { kind: "journal-article" } : {}),
    sources: ["s2"],
  };
}

/** A paper id for S2: DOI:<doi>, ARXIV:<id>, or a 40-hex paperId. */
export function s2Id(id: { doi?: string; arxiv?: string; s2?: string }): string {
  if (id.s2 && /^[0-9a-f]{40}$/.test(id.s2)) return id.s2;
  if (id.doi) return `DOI:${id.doi}`;
  if (id.arxiv) return `ARXIV:${id.arxiv}`;
  throw new LitError("no id Semantic Scholar can look up", "not_found");
}

export const semanticScholar = (http: LitHttp) => ({
  source: "s2" as const,
  async search(query: string, o: SearchOptions): Promise<PaperRecord[]> {
    const u = new URL(`${S2}/paper/search`);
    u.searchParams.set("query", query);
    u.searchParams.set("limit", String(Math.min(o.limit, 50)));
    u.searchParams.set("fields", S2_FIELDS);
    const y = yearRange(o);
    if (y) u.searchParams.set("year", `${y[0]}-${y[1]}`);
    const r = await http.get("s2", u);
    if (r.status !== 200) throw new LitError(`s2 search: HTTP ${r.status}`, "error");
    return (json<{ data?: S2Paper[] }>(r.body, "s2").data ?? []).map(fromS2).filter((x): x is PaperRecord => x !== undefined);
  },
  async paper(id: { doi?: string; arxiv?: string; s2?: string }): Promise<PaperRecord | undefined> {
    const r = await http.get("s2", new URL(`${S2}/paper/${encodeURI(s2Id(id))}?fields=${S2_FIELDS}`));
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new LitError(`s2 paper: HTTP ${r.status}`, "error");
    return fromS2(json<S2Paper>(r.body, "s2"));
  },
  /** One step of the citation graph: the paper's references, or the papers citing it. */
  async graph(id: { doi?: string; arxiv?: string; s2?: string }, direction: "references" | "citations", limit: number): Promise<PaperRecord[]> {
    const u = new URL(`${S2}/paper/${encodeURI(s2Id(id))}/${direction}`);
    u.searchParams.set("limit", String(Math.min(limit, 100)));
    u.searchParams.set("fields", "title,year,authors,venue,externalIds");
    const r = await http.get("s2", u);
    if (r.status === 404) throw new LitError("Semantic Scholar doesn't know this paper", "not_found");
    if (r.status !== 200) throw new LitError(`s2 ${direction}: HTTP ${r.status}`, "error");
    const key = direction === "references" ? "citedPaper" : "citingPaper";
    return (json<{ data?: Record<string, S2Paper>[] }>(r.body, "s2").data ?? []).map((d) => (d[key] ? fromS2(d[key]!) : undefined)).filter((x): x is PaperRecord => x !== undefined);
  },
});

// ---------- OpenAlex ----------

const OA = "https://api.openalex.org";
const OA_SELECT = "id,doi,display_name,publication_year,authorships,primary_location,ids,abstract_inverted_index,cited_by_count,type";

interface OAWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  publication_year?: number;
  type?: string;
  cited_by_count?: number;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null } | null;
  ids?: { arxiv?: string };
  abstract_inverted_index?: Record<string, number[]> | null;
  referenced_works?: string[];
}

/** OpenAlex ships abstracts as {word: [positions]}. */
export function invertedAbstract(idx: Record<string, number[]> | null | undefined): string | undefined {
  if (!idx) return undefined;
  const words: string[] = [];
  for (const [w, ps] of Object.entries(idx)) for (const p of ps) if (p >= 0 && p < 5000) words[p] = w;
  const text = words.filter((w) => w !== undefined).join(" ");
  return text ? clip(plain(text), ABSTRACT_MAX) : undefined;
}

export function fromOpenAlex(w: OAWork): PaperRecord | undefined {
  if (!w.display_name) return undefined;
  const doi = normDoi(w.doi);
  const oa = /W\d+$/.exec(w.id ?? "")?.[0];
  const arxiv = normArxiv(w.ids?.arxiv);
  const abstract = invertedAbstract(w.abstract_inverted_index);
  const venue = w.primary_location?.source?.display_name;
  return {
    ids: { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(oa ? { openalex: oa } : {}) },
    title: plain(w.display_name),
    authors: (w.authorships ?? []).map((a) => plain(a.author?.display_name)).filter(Boolean),
    ...(w.publication_year ? { year: w.publication_year } : {}),
    ...(venue ? { venue: plain(venue) } : {}),
    ...(abstract ? { abstract } : {}),
    ...(w.cited_by_count !== undefined ? { citations: w.cited_by_count } : {}),
    ...(w.type === "article" ? { kind: "journal-article" } : w.type === "preprint" ? { kind: "preprint" } : {}),
    sources: ["openalex"],
  };
}

export const openAlex = (http: LitHttp) => ({
  source: "openalex" as const,
  async search(query: string, o: SearchOptions): Promise<PaperRecord[]> {
    const u = new URL(`${OA}/works`);
    u.searchParams.set("search", query);
    u.searchParams.set("per-page", String(Math.min(o.limit, 50)));
    u.searchParams.set("select", OA_SELECT);
    const y = yearRange(o);
    if (y) u.searchParams.set("filter", `publication_year:${y[0]}-${y[1]}`);
    const r = await http.get("openalex", u);
    if (r.status !== 200) throw new LitError(`openalex search: HTTP ${r.status}`, "error");
    return (json<{ results?: OAWork[] }>(r.body, "openalex").results ?? []).map(fromOpenAlex).filter((x): x is PaperRecord => x !== undefined);
  },
  async work(id: { doi?: string; openalex?: string }): Promise<PaperRecord | undefined> {
    const path = id.openalex && /^W\d+$/.test(id.openalex) ? id.openalex : id.doi ? `doi:${id.doi}` : undefined;
    if (!path) throw new LitError("no id OpenAlex can look up", "not_found");
    const r = await http.get("openalex", new URL(`${OA}/works/${encodeURI(path)}?select=${OA_SELECT}`));
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new LitError(`openalex work: HTTP ${r.status}`, "error");
    return fromOpenAlex(json<OAWork>(r.body, "openalex"));
  },
});

// ---------- arXiv (Atom) ----------

const ARXIV = "https://export.arxiv.org/api/query";
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]!).trim() : undefined;
};

export function fromArxivAtom(xml: string): PaperRecord[] {
  const out: PaperRecord[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const arxiv = normArxiv(tag(e, "id"));
    const title = plain(tag(e, "title"));
    if (!arxiv || !title) continue;
    const doi = normDoi(tag(e, "arxiv:doi"));
    const published = tag(e, "published");
    const venue = tag(e, "arxiv:journal_ref");
    const summary = tag(e, "summary");
    out.push({
      ids: { arxiv, ...(doi ? { doi } : {}) },
      title,
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => plain(decodeEntities(a[1]!))).filter(Boolean),
      ...(published ? { year: Number(published.slice(0, 4)) } : {}),
      ...(venue ? { venue: plain(venue) } : {}),
      ...(summary ? { abstract: clip(plain(summary), ABSTRACT_MAX) } : {}),
      kind: "preprint",
      sources: ["arxiv"],
    });
  }
  return out;
}

/** arXiv query: words joined with AND over all fields (quotes and boolean syntax from the caller are not passed). */
export const arxivQuery = (q: string) =>
  q
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(AND|OR|ANDNOT)$/i.test(w))
    .slice(0, 12)
    .map((w) => `all:${w}`)
    .join(" AND ");

export const arxiv = (http: LitHttp) => ({
  source: "arxiv" as const,
  async search(query: string, o: SearchOptions): Promise<PaperRecord[]> {
    const q = arxivQuery(query);
    if (!q) return [];
    const u = new URL(ARXIV);
    u.searchParams.set("search_query", q);
    u.searchParams.set("max_results", String(Math.min(o.limit, 50)));
    const r = await http.get("arxiv", u, { accept: "application/atom+xml" });
    if (r.status !== 200) throw new LitError(`arxiv search: HTTP ${r.status}`, "error");
    const y = yearRange(o);
    return fromArxivAtom(r.body).filter((p) => !y || (p.year !== undefined && p.year >= y[0]! && p.year <= y[1]!));
  },
  async paper(id: string): Promise<PaperRecord | undefined> {
    const a = normArxiv(id);
    if (!a) throw new LitError(`not an arXiv id: ${id}`, "not_found");
    const u = new URL(ARXIV);
    u.searchParams.set("id_list", a);
    const r = await http.get("arxiv", u, { accept: "application/atom+xml" });
    if (r.status !== 200) throw new LitError(`arxiv paper: HTTP ${r.status}`, "error");
    return fromArxivAtom(r.body).find((p) => p.ids.arxiv === a);
  },
});

// ---------- Crossref ----------

const CR = "https://api.crossref.org/works";
const CR_SELECT = "DOI,title,author,issued,container-title,type,abstract,is-referenced-by-count";

interface CRWork {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: (number | null)[][] };
  "container-title"?: string[];
  type?: string;
  abstract?: string;
  "is-referenced-by-count"?: number;
}

export function fromCrossref(w: CRWork): PaperRecord | undefined {
  const doi = normDoi(w.DOI);
  const title = plain(w.title?.[0]);
  if (!doi || !title) return undefined;
  const year = w.issued?.["date-parts"]?.[0]?.[0];
  const venue = w["container-title"]?.[0];
  return {
    ids: { doi },
    title,
    authors: (w.author ?? []).map((a) => plain(a.family ? `${a.family}, ${a.given ?? ""}`.replace(/, $/, "") : a.name)).filter(Boolean),
    ...(year ? { year } : {}),
    ...(venue ? { venue: plain(venue) } : {}),
    ...(w.abstract ? { abstract: clip(plain(w.abstract), ABSTRACT_MAX) } : {}),
    ...(w["is-referenced-by-count"] !== undefined ? { citations: w["is-referenced-by-count"] } : {}),
    ...(w.type ? { kind: w.type } : {}),
    sources: ["crossref"],
  };
}

export const crossref = (http: LitHttp) => ({
  source: "crossref" as const,
  async search(query: string, o: SearchOptions): Promise<PaperRecord[]> {
    const u = new URL(CR);
    u.searchParams.set("query.bibliographic", query);
    u.searchParams.set("rows", String(Math.min(o.limit, 50)));
    u.searchParams.set("select", CR_SELECT);
    const y = yearRange(o);
    if (y) u.searchParams.set("filter", `from-pub-date:${y[0]},until-pub-date:${y[1]}`);
    const r = await http.get("crossref", u);
    if (r.status !== 200) throw new LitError(`crossref search: HTTP ${r.status}`, "error");
    return (json<{ message?: { items?: CRWork[] } }>(r.body, "crossref").message?.items ?? []).map(fromCrossref).filter((x): x is PaperRecord => x !== undefined);
  },
  async work(doi: string): Promise<PaperRecord | undefined> {
    const r = await http.get("crossref", new URL(`${CR}/${encodeURI(doi)}`));
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new LitError(`crossref work: HTTP ${r.status}`, "error");
    return fromCrossref(json<{ message?: CRWork }>(r.body, "crossref").message ?? {});
  },
});

// ---------- doi.org (registration) ----------

/** Is this DOI registered? doi.org's handle API: responseCode 1 = yes, 100 = no such handle. */
export async function doiRegistered(http: LitHttp, doi: string): Promise<boolean> {
  const r = await http.get("doi", new URL(`https://doi.org/api/handles/${encodeURI(doi)}`));
  if (r.status === 404) return false;
  if (r.status !== 200) throw new LitError(`doi.org: HTTP ${r.status}`, "error");
  const code = json<{ responseCode?: number }>(r.body, "doi.org").responseCode;
  if (code === 1) return true;
  if (code === 100 || code === 200) return false;
  throw new LitError(`doi.org: unexpected responseCode ${code}`, "error");
}
