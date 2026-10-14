import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LitError, LitHttp } from "./net.js";
import { bibValue, citekey, mergeRecords, normArxiv, normDoi, type PaperRecord, titleSimilarity, toBibtex } from "./records.js";
import { LiteratureService, parsePaperId } from "./service.js";
import { arxivQuery, fromArxivAtom, fromCrossref, fromOpenAlex, fromS2, invertedAbstract } from "./sources.js";

// Trimmed from real responses (2026-10-14).
const SZ3_DOI = "10.1109/tbdata.2022.3201176";
const CROSSREF_SZ3 = {
  DOI: "10.1109/TBDATA.2022.3201176",
  title: ["SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors"],
  author: [{ given: "Xin", family: "Liang" }, { given: "Kai", family: "Zhao" }],
  issued: { "date-parts": [[2023, 4, 1]] },
  "container-title": ["IEEE Transactions on Big Data"],
  type: "journal-article",
};
const OPENALEX_WORK = {
  id: "https://openalex.org/W3174738244",
  doi: "https://doi.org/10.1109/icde51399.2021.00145",
  display_name: "Optimizing Error-Bounded Lossy Compression for Scientific Data by Dynamic Spline Interpolation",
  publication_year: 2021,
  type: "article",
  authorships: [{ author: { display_name: "Kai Zhao" } }, { author: { display_name: "Sheng Di" } }],
  primary_location: { source: { display_name: "Proceedings - International Conference on Data Engineering" } },
  abstract_inverted_index: { Today: [0], "data": [1, 3], grows: [2] },
};
const ARXIV_ATOM = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>http://arxiv.org/abs/2304.11768v2</id>
    <title>TopoSZ: Preserving Topology in Error-Bounded Lossy Compression</title>
    <summary>Existing error-bounded &amp; lossy compression techniques control the pointwise error.</summary>
    <published>2023-04-23T23:25:01Z</published>
    <author>
      <name>Lin Yan</name>
    </author>
    <author>
      <name>Xin Liang</name>
    </author>
  </entry></feed>`;

type Route = (u: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => `${url.host}${url.pathname}`.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return routes[key]!(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const okJson = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "cairn-lit-"));
});
afterEach(async () => {
  await rm(cache, { recursive: true, force: true });
});

describe("records", () => {
  it("normalizes ids", () => {
    expect(normDoi("https://doi.org/10.1109/TBDATA.2022.3201176")).toBe(SZ3_DOI);
    expect(normDoi("not-a-doi")).toBeUndefined();
    expect(normArxiv("http://arxiv.org/abs/2304.11768v2")).toBe("2304.11768");
    expect(normArxiv("arXiv:hep-th/9901001v3")).toBe("hep-th/9901001");
    expect(normArxiv("2304.1")).toBeUndefined();
    expect(parsePaperId("doi:10.1109/X.1")).toEqual({ doi: "10.1109/x.1" });
    expect(parsePaperId("2304.11768")).toEqual({ arxiv: "2304.11768" });
    expect(parsePaperId("openalex:W123")).toEqual({ openalex: "W123" });
    expect(() => parsePaperId("../../etc/passwd")).toThrow(/not a paper id/);
  });

  it("parses each source's shape", () => {
    expect(fromCrossref(CROSSREF_SZ3)).toMatchObject({ ids: { doi: SZ3_DOI }, authors: ["Liang, Xin", "Zhao, Kai"], year: 2023, venue: "IEEE Transactions on Big Data", kind: "journal-article" });
    expect(fromOpenAlex(OPENALEX_WORK)).toMatchObject({ ids: { doi: "10.1109/icde51399.2021.00145", openalex: "W3174738244" }, abstract: "Today data grows data", year: 2021 });
    expect(fromArxivAtom(ARXIV_ATOM)).toEqual([
      { ids: { arxiv: "2304.11768" }, title: "TopoSZ: Preserving Topology in Error-Bounded Lossy Compression", authors: ["Lin Yan", "Xin Liang"], year: 2023, abstract: "Existing error-bounded & lossy compression techniques control the pointwise error.", kind: "preprint", sources: ["arxiv"] },
    ]);
    expect(fromS2({ paperId: "a".repeat(40), title: "T <i>x</i>", year: 2020, externalIds: { DOI: "10.1234/AB", ArXiv: "2001.00001" }, authors: [{ name: "A B" }] })).toMatchObject({ ids: { doi: "10.1234/ab", arxiv: "2001.00001", s2: "a".repeat(40) }, title: "T x" });
    expect(invertedAbstract(null)).toBeUndefined();
    expect(arxivQuery('"error-bounded" AND (lossy) OR x')).toBe("all:error-bounded AND all:lossy");
  });

  it("merges the same work from several sources", () => {
    const a = fromCrossref(CROSSREF_SZ3)!;
    const b: PaperRecord = { ids: { doi: SZ3_DOI, openalex: "W1" }, title: a.title, authors: [], abstract: "longer abstract", citations: 5, sources: ["openalex"] };
    expect(mergeRecords([a, b])).toEqual([{ ...a, ids: { doi: SZ3_DOI, openalex: "W1" }, abstract: "longer abstract", citations: 5, sources: ["crossref", "openalex"] }]);
    expect(titleSimilarity("SZ3: A Modular Framework", "sz3 a modular framework!")).toBe(1);
    // Same title, different DOIs: two works, not one.
    expect(mergeRecords([a, { ...a, ids: { doi: "10.1234/other" } }])).toHaveLength(2);
  });

  it("BibTeX can't carry LaTeX commands, and citekeys are plain", () => {
    expect(bibValue("A \\input{/etc/passwd} and \\write18{rm -rf ~} 100% {x}")).toBe("A input/etc/passwd and write18rm -rf ~ 100\\% x".replace("~", "\\~{}"));
    const r: PaperRecord = { ids: { doi: SZ3_DOI }, title: "SZ3: \\immediate\\write18{x}", authors: ["Müller, Jürgen"], year: 2023, kind: "journal-article", venue: "J_x & Co", sources: ["crossref"] };
    const key = citekey(r);
    expect(key).toBe("muller2023sz3");
    const bib = toBibtex(r, key);
    expect(bib).not.toMatch(/\\(?!_|&|%|\$|#|\^|~)/); // the only backslashes left escape TeX specials
    expect(bib).toContain("journal = {J\\_x \\& Co}");
    expect(() => toBibtex(r, "bad key}")).toThrow(/bad citekey/);
  });
});

describe("LitHttp (host side)", () => {
  it("sends the contact address only to OpenAlex and Crossref, and the S2 key only to S2", async () => {
    const { f, calls } = fakeFetch({
      "api.openalex.org/works": () => okJson({ results: [] }),
      "api.crossref.org/works": () => okJson({ message: { items: [] } }),
      "export.arxiv.org/api/query": () => new Response("<feed></feed>", { headers: { "content-type": "application/atom+xml" } }),
      "api.semanticscholar.org/graph/v1/paper/search": () => okJson({ data: [] }),
    });
    const svc = new LiteratureService(new LitHttp({ fetch: f, contactEmail: "me@uni.edu", s2Key: "S2KEY", sleep: noSleep }));
    await svc.search("lossy compression");
    for (const c of calls) {
      const host = c.url.host;
      const all = `${decodeURIComponent(String(c.url))} ${JSON.stringify(c.headers)}`;
      if (host === "api.openalex.org" || host === "api.crossref.org") expect(all, host).toContain("me@uni.edu");
      else expect(all, host).not.toContain("me@uni.edu");
      if (host === "api.semanticscholar.org") expect(c.headers["x-api-key"]).toBe("S2KEY");
      else expect(all, host).not.toContain("S2KEY");
    }
    expect(calls).toHaveLength(4);
  });

  it("follows redirects only within a service's hosts", async () => {
    const { f } = fakeFetch({ "doi.org/api/handles": () => new Response(null, { status: 302, headers: { location: "https://data.crosscite.org/x" } }) });
    const http = new LitHttp({ fetch: f, sleep: noSleep });
    await expect(http.get("doi", new URL("https://doi.org/api/handles/10.1/x"))).rejects.toMatchObject({ kind: "blocked", message: "doi redirected to data.crosscite.org, which is not allowed" });
    await expect(http.get("doi", new URL("https://evil.example/x"))).rejects.toThrow(/not doi's host/);
  });

  it("reports bot checks as blocked, 429 as throttled, and pauses a failing source", async () => {
    let n = 0;
    const { f } = fakeFetch({
      "dblp-like.example": () => new Response(""),
      "api.crossref.org/works": () => new Response("<!doctype html><title>Making sure you're not a bot!</title>", { status: 202, headers: { "content-type": "text/html" } }),
      "api.semanticscholar.org": () => new Response("slow down", { status: 429, headers: { "retry-after": "60" } }),
      "api.openalex.org": () => {
        n++;
        return new Response("boom", { status: 503 });
      },
    });
    const http = new LitHttp({ fetch: f, sleep: noSleep });
    const svc = new LiteratureService(http);
    const r = await svc.search("lossy compression", { sources: ["crossref", "s2", "openalex"] });
    expect(r.sources).toEqual([
      { source: "crossref", status: "blocked", count: 0, detail: "crossref answered with a bot check or HTML page, not data" },
      { source: "s2", status: "throttled", count: 0, detail: "s2 is rate-limiting us (HTTP 429); a free API key raises the limit (re literature key s2)" },
      { source: "openalex", status: "error", count: 0, detail: "openalex: HTTP 503" },
    ]);
    await svc.search("a", { sources: ["openalex"] }).catch(() => {});
    await svc.search("lossy two", { sources: ["openalex"] });
    await svc.search("lossy three", { sources: ["openalex"] });
    const paused = await svc.search("lossy four", { sources: ["openalex"] });
    expect(paused.sources[0]).toMatchObject({ status: "throttled", detail: expect.stringMatching(/paused: repeated failures/) });
    expect(n).toBe(3);
  });

  it("stops using OpenAlex before its daily credits run out", async () => {
    const { f, calls } = fakeFetch({ "api.openalex.org/works": () => okJson({ results: [] }, { "x-ratelimit-remaining": "40", "x-ratelimit-reset": "3600" }) });
    const svc = new LiteratureService(new LitHttp({ fetch: f, sleep: noSleep }));
    await svc.search("first", { sources: ["openalex"] });
    const r = await svc.search("second", { sources: ["openalex"] });
    expect(r.sources[0]).toMatchObject({ status: "throttled", detail: expect.stringMatching(/daily credits nearly used \(40 left\)/) });
    expect(calls).toHaveLength(1);
  });

  it("caches answers on disk without the contact address", async () => {
    const { f, calls } = fakeFetch({ "api.crossref.org/works": () => okJson({ message: { items: [CROSSREF_SZ3] } }) });
    const svc = new LiteratureService(new LitHttp({ fetch: f, cacheDir: cache, contactEmail: "me@uni.edu", sleep: noSleep }));
    await svc.search("sz3", { sources: ["crossref"] });
    const again = await svc.search("sz3", { sources: ["crossref"] });
    expect(again.records).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const files = await readdir(cache);
    for (const x of files) expect(await readFile(join(cache, x), "utf8")).not.toContain("me@uni.edu");
  });
});

describe("resolve (citations must be verifiable)", () => {
  const routes = (extra: Record<string, Route> = {}) =>
    fakeFetch({
      "doi.org/api/handles/10.1109/tbdata.2022.3201176": () => okJson({ responseCode: 1 }),
      "doi.org/api/handles/": () => new Response(JSON.stringify({ responseCode: 100 }), { status: 404 }),
      "api.crossref.org/works/10.1109/tbdata.2022.3201176": () => okJson({ message: CROSSREF_SZ3 }),
      "export.arxiv.org/api/query": (u) => new Response(u.searchParams.get("id_list") === "2304.11768" ? ARXIV_ATOM : "<feed></feed>"),
      ...extra,
    });

  it("a registered DOI with metadata resolves to BibTeX; an unregistered one doesn't", async () => {
    const svc = new LiteratureService(new LitHttp({ fetch: routes().f, sleep: noSleep }));
    const r = await svc.resolve({ doi: "https://doi.org/10.1109/TBDATA.2022.3201176" });
    expect(r).toMatchObject({ status: "resolved", citekey: "liang2023sz3", checks: ["doi.org: 10.1109/tbdata.2022.3201176 is registered", "metadata from crossref"] });
    expect(r.bibtex).toContain("@article{liang2023sz3,");
    expect(await svc.resolve({ doi: "10.9999/nope" })).toEqual({ status: "not_found", checks: ["doi.org: 10.9999/nope is not registered"] });
    expect((await svc.resolve({ arxiv: "2304.11768v2" })).citekey).toBe("yan2023toposz");
    expect((await svc.resolve({ arxiv: "2304.99999" })).status).toBe("not_found");
  });

  it("a title resolves only to exactly one close match; otherwise inconclusive, with candidates and no BibTeX", async () => {
    const twin = { ...CROSSREF_SZ3, DOI: "10.1109/other.1", title: ["SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors"] };
    const one = routes({ "api.crossref.org/works": () => okJson({ message: { items: [CROSSREF_SZ3] } }), "api.openalex.org/works": () => okJson({ results: [] }) });
    const svc = new LiteratureService(new LitHttp({ fetch: one.f, sleep: noSleep }));
    const r = await svc.resolve({ title: "SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors", year: 2023, author: "Xin Liang" });
    expect(r.status).toBe("resolved");
    expect(r.checks[0]).toMatch(/1 close/);
    const two = routes({ "api.crossref.org/works": () => okJson({ message: { items: [CROSSREF_SZ3, twin] } }), "api.openalex.org/works": () => okJson({ results: [] }) });
    const amb = await new LiteratureService(new LitHttp({ fetch: two.f, sleep: noSleep })).resolve({ title: "SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors" });
    expect(amb).toMatchObject({ status: "inconclusive", checks: [expect.any(String), "more than one paper matches; cite it by DOI or arXiv id"] });
    expect(amb.bibtex).toBeUndefined();
    expect(amb.candidates).toHaveLength(2);
    expect((await svc.resolve({ title: "short" })).status).toBe("not_found");
  });

  it("LitError kinds are stable for callers", () => {
    expect(new LitError("x", "blocked").kind).toBe("blocked");
  });
});
