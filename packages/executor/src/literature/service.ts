// The literature service (M7) behind re literature and the literature.* MCP tools. Pure data: no model is called
// inside it (every model call stays in the agent loop and the event log, invariant 6). Results are external,
// untrusted metadata.
import { type LitHttp, LitError } from "./net.js";
import { arxivFromDoi, citekey, type LitSource, LIT_SOURCES, mergeRecords, normArxiv, normDoi, type PaperRecord, samePaper, surname, titleSimilarity, toBibtex } from "./records.js";
import { arxiv, crossref, doiRegistered, openAlex, type SearchOptions, semanticScholar } from "./sources.js";

export interface SourceStatus {
  source: LitSource;
  status: "ok" | "empty" | "error" | "throttled" | "blocked";
  count: number;
  detail?: string;
}

export interface SearchResult {
  query: string;
  records: PaperRecord[];
  sources: SourceStatus[];
}

export type ResolveInput = { doi: string } | { arxiv: string } | { title: string; year?: number; author?: string };

export interface Resolution {
  status: "resolved" | "not_found" | "inconclusive";
  /** What was checked, in order (shown to the user and recorded with the reference). */
  checks: string[];
  record?: PaperRecord;
  citekey?: string;
  bibtex?: string;
  /** For inconclusive title lookups: the closest candidates, for a human or agent to pick an id from. */
  candidates?: PaperRecord[];
}

/** A paper id as written by a user or agent: doi:…, arxiv:…, s2:…, openalex:W…, or a bare DOI / arXiv id. */
export function parsePaperId(s: string): { doi?: string; arxiv?: string; s2?: string; openalex?: string } {
  const t = s.trim();
  const m = /^(doi|arxiv|s2|openalex):(.+)$/i.exec(t);
  const kind = m?.[1]?.toLowerCase();
  const v = m?.[2] ?? t;
  if (kind === "s2") {
    if (!/^[0-9a-f]{40}$/.test(v)) throw new LitError(`not a Semantic Scholar paper id: ${v}`, "not_found");
    return { s2: v };
  }
  if (kind === "openalex") {
    const w = /^(?:https:\/\/openalex\.org\/)?(W\d+)$/.exec(v)?.[1];
    if (!w) throw new LitError(`not an OpenAlex work id: ${v}`, "not_found");
    return { openalex: w };
  }
  const doi = kind !== "arxiv" ? normDoi(v) : undefined;
  if (doi) return { doi };
  const a = kind !== "doi" ? normArxiv(v) : undefined;
  if (a) return { arxiv: a };
  throw new LitError(`not a paper id: ${s} (use doi:…, arxiv:…, s2:…, openalex:W…)`, "not_found");
}


export class LiteratureService {
  readonly #s2;
  readonly #oa;
  readonly #ax;
  readonly #cr;

  constructor(readonly http: LitHttp) {
    this.#s2 = semanticScholar(http);
    this.#oa = openAlex(http);
    this.#ax = arxiv(http);
    this.#cr = crossref(http);
  }

  /** Keyword search across sources in parallel; one source failing never fails the search. */
  async search(query: string, o: Partial<SearchOptions> & { sources?: LitSource[] } = {}): Promise<SearchResult> {
    const q = query.trim();
    if (q.length < 2 || q.length > 300) throw new LitError("query must be 2-300 characters", "error");
    const opts: SearchOptions = { limit: Math.max(1, Math.min(o.limit ?? 10, 50)), ...(o.yearFrom ? { yearFrom: o.yearFrom } : {}), ...(o.yearTo ? { yearTo: o.yearTo } : {}) };
    const chosen = (o.sources?.length ? o.sources : [...LIT_SOURCES]).filter((s) => (LIT_SOURCES as readonly string[]).includes(s));
    const adapters = { s2: this.#s2, openalex: this.#oa, arxiv: this.#ax, crossref: this.#cr };
    const settled = await Promise.allSettled(chosen.map((s) => adapters[s].search(q, opts)));
    const sources: SourceStatus[] = [];
    const all: PaperRecord[] = [];
    settled.forEach((r, i) => {
      const source = chosen[i]!;
      if (r.status === "fulfilled") {
        sources.push({ source, status: r.value.length ? "ok" : "empty", count: r.value.length });
        all.push(...r.value);
      } else {
        const e = r.reason as Error;
        sources.push({ source, status: e instanceof LitError && e.kind !== "not_found" ? e.kind : "error", count: 0, detail: e.message });
      }
    });
    return { query: q, records: mergeRecords(all).slice(0, opts.limit * chosen.length), sources };
  }

  /** Metadata for one paper, merged from the sources that know it. */
  async fetch(id: string): Promise<{ record: PaperRecord; sources: SourceStatus[] }> {
    const ids = parsePaperId(id);
    const tries: [LitSource, () => Promise<PaperRecord | undefined>][] = [];
    if (ids.doi) tries.push(["crossref", () => this.#cr.work(ids.doi!)], ["openalex", () => this.#oa.work(ids)]);
    if (ids.openalex) tries.push(["openalex", () => this.#oa.work(ids)]);
    const ax = ids.arxiv ?? arxivFromDoi(ids.doi);
    if (ax) tries.push(["arxiv", () => this.#ax.paper(ax)]);
    tries.push(["s2", () => this.#s2.paper(ids)]);
    const found: PaperRecord[] = [];
    const sources: SourceStatus[] = [];
    for (const [source, run] of tries) {
      try {
        const r = await run();
        sources.push({ source, status: r ? "ok" : "empty", count: r ? 1 : 0 });
        if (r) found.push(r);
      } catch (e) {
        const err = e as Error;
        sources.push({ source, status: err instanceof LitError && err.kind !== "not_found" ? err.kind : "error", count: 0, detail: err.message });
      }
    }
    const [record] = mergeRecords(found);
    if (!record) throw new LitError(`no source knows ${id}`, "not_found");
    return { record, sources };
  }

  /** One step of the citation graph (Semantic Scholar). */
  async expand(id: string, direction: "references" | "citations", limit = 20): Promise<PaperRecord[]> {
    return this.#s2.graph(parsePaperId(id), direction, Math.max(1, Math.min(limit, 100)));
  }

  /**
   * Verify a citation and produce its BibTeX. A DOI must be registered (doi.org) and described by Crossref, OpenAlex,
   * or arXiv; an arXiv id must exist on arXiv; a title must match exactly one paper closely (title similarity ≥ 0.9,
   * same year and first author when given), which is then resolved by its DOI or arXiv id. Anything less is
   * inconclusive: no BibTeX, so it can't be cited.
   *
   * A preprint and its published version are one reference: the published version, with the arXiv id kept as its
   * eprint. An arXiv id whose record names a registered journal DOI resolves to that publication; a DOI whose
   * publisher names an arXiv preprint keeps it once arXiv confirms it. Unless they differ substantially (title or
   * first author, see samePaper), in which case each is cited as itself.
   */
  async resolve(input: ResolveInput): Promise<Resolution> {
    const checks: string[] = [];
    if ("doi" in input) {
      const doi = normDoi(input.doi);
      if (!doi) return { status: "not_found", checks: [`not a DOI: ${input.doi}`] };
      if (!(await doiRegistered(this.http, doi))) return { status: "not_found", checks: [`doi.org: ${doi} is not registered`] };
      checks.push(`doi.org: ${doi} is registered`);
      const ax = arxivFromDoi(doi);
      const record = ax ? await this.#ax.paper(ax) : ((await this.#cr.work(doi).catch(() => undefined)) ?? (await this.#oa.work({ doi }).catch(() => undefined)));
      if (!record) return { status: "inconclusive", checks: [...checks, "registered, but neither Crossref nor OpenAlex describes it"] };
      checks.push(`metadata from ${record.sources.join(", ")}`);
      // An arXiv DOI resolves as the arXiv id (and so to its publication, if any).
      if (ax) return this.resolve({ arxiv: ax }).then((r) => ({ ...r, checks: [...checks, ...r.checks] }));
      const published: PaperRecord = { ...record, ids: { ...record.ids, doi } };
      if (published.ids.arxiv) {
        const pre = await this.#ax.paper(published.ids.arxiv).catch(() => undefined);
        if (pre && samePaper(pre, published)) checks.push(`its preprint arXiv:${published.ids.arxiv} exists and is the same paper (kept as eprint)`);
        else {
          checks.push(`the publisher names preprint arXiv:${published.ids.arxiv}, but ${pre ? "it differs substantially" : "arXiv doesn't confirm it"}: not linked`);
          delete published.ids.arxiv;
        }
      }
      return this.#resolved(published, checks);
    }
    if ("arxiv" in input) {
      const a = normArxiv(input.arxiv);
      if (!a) return { status: "not_found", checks: [`not an arXiv id: ${input.arxiv}`] };
      const record = await this.#ax.paper(a);
      if (!record) return { status: "not_found", checks: [`arXiv has no ${a}`] };
      checks.push(`arXiv: ${a} exists`);
      const journal = record.ids.doi && !arxivFromDoi(record.ids.doi) ? record.ids.doi : undefined;
      if (journal) {
        if (await doiRegistered(this.http, journal)) {
          const published = (await this.#cr.work(journal).catch(() => undefined)) ?? (await this.#oa.work({ doi: journal }).catch(() => undefined));
          if (published && samePaper(record, published)) {
            checks.push(`published as ${journal} (registered; metadata from ${published.sources.join(", ")}): cited as the publication, with the preprint as its eprint`);
            return this.#resolved({ ...published, ids: { ...published.ids, doi: journal, arxiv: a }, sources: [...new Set([...published.sources, ...record.sources])] }, checks);
          }
          checks.push(`arXiv names ${journal}, but ${published ? "it differs substantially (title or first author)" : "no source describes it"}: cited as the preprint`);
        } else checks.push(`arXiv names ${journal}, which is not registered: cited as the preprint`);
        record.ids = { arxiv: a };
      }
      return this.#resolved(record, checks);
    }
    const title = input.title.trim();
    if (title.length < 8) return { status: "not_found", checks: ["title too short to identify a paper"] };
    const found = (await this.search(title, { sources: ["crossref", "openalex"], limit: 5, ...(input.year ? { yearFrom: input.year, yearTo: input.year } : {}) })).records;
    const close = found
      .map((r) => ({ r, sim: titleSimilarity(title, r.title) }))
      .filter(({ r, sim }) => sim >= 0.9 && (!input.year || r.year === input.year) && (!input.author || r.authors.some((a) => surname(a) === surname(input.author!))))
      .sort((a, b) => b.sim - a.sim);
    checks.push(`title search (Crossref, OpenAlex): ${found.length} candidates, ${close.length} close (title similarity ≥ 0.9${input.year ? ", same year" : ""}${input.author ? ", same author" : ""})`);
    const distinct = mergeRecords(close.map((c) => c.r));
    if (distinct.length !== 1) return { status: "inconclusive", checks: [...checks, distinct.length ? "more than one paper matches; cite it by DOI or arXiv id" : "no close match"], candidates: found.slice(0, 5) };
    const only = distinct[0]!;
    const by = only.ids.doi ? await this.resolve({ doi: only.ids.doi }) : only.ids.arxiv ? await this.resolve({ arxiv: only.ids.arxiv }) : undefined;
    if (!by) return { status: "inconclusive", checks: [...checks, "the match has no DOI or arXiv id"], candidates: [only] };
    return { ...by, checks: [...checks, ...by.checks] };
  }

  #resolved(record: PaperRecord, checks: string[]): Resolution {
    const key = citekey(record);
    return { status: "resolved", checks, record, citekey: key, bibtex: toBibtex(record, key) };
  }
}
