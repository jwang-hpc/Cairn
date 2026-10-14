import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { readLiteratureKeys } from "./literature.js";

const SZ3_DOI = "10.1109/TBDATA.2022.3201176";
const CROSSREF_SZ3 = {
  DOI: SZ3_DOI,
  title: ["SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors"],
  author: [{ given: "Xin", family: "Liang" }, { given: "Kai", family: "Zhao" }],
  issued: { "date-parts": [[2023, 4, 1]] },
  "container-title": ["IEEE Transactions on Big Data"],
  type: "journal-article",
};
const OPENALEX_SZ3 = {
  id: "https://openalex.org/W4293659389",
  doi: `https://doi.org/${SZ3_DOI.toLowerCase()}`,
  display_name: CROSSREF_SZ3.title[0],
  publication_year: 2023,
  type: "article",
  authorships: [{ author: { display_name: "Xin Liang" } }],
};

let root: string;
let engine: Engine;
let calls: { url: URL; headers: Record<string, string> }[];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
  const url = new URL(String(input));
  calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
  const path = `${url.host}${url.pathname}`;
  if (path === `doi.org/api/handles/${SZ3_DOI.toLowerCase()}`) return json({ responseCode: 1, handle: SZ3_DOI });
  if (path.startsWith("doi.org/api/handles/")) return new Response(JSON.stringify({ responseCode: 100 }), { status: 404 });
  if (path === `api.crossref.org/works/${SZ3_DOI.toLowerCase()}`) return json({ status: "ok", message: CROSSREF_SZ3 });
  if (path === "api.crossref.org/works") return json({ status: "ok", message: { items: [CROSSREF_SZ3] } });
  if (path === "api.openalex.org/works") return json({ results: [OPENALEX_SZ3] });
  if (path.startsWith("api.semanticscholar.org")) return new Response("Too Many Requests", { status: 429 });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-lit-cli-"));
  calls = [];
  const cfg: LoadedConfig = {
    dir: "(test)",
    models: { providers: {}, models: {}, effort_map: {}, routing: {}, projects_default_data_class: "unpublished" },
    roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
    machines: { machines: {} },
    engine: {
      machine: "test",
      projects_dir: join(root, "projects"),
      budget: { daily: { usd: { total: 1 }, tokens: {} }, run: { max_usd: 1, max_tokens: 1000, max_turns: 2 } },
      literature: { contact_email: "someone@university.edu" },
    },
  };
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  engine = new Engine(cfg, { configDir: "(test)", home: join(root, "home") }, { models: { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) }, stores });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function re(argv: string[], answer?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    ...(answer !== undefined ? { login: { show: () => {}, ask: async () => answer, choose: async () => "" } } : {}),
  };
  const code = await runCli(argv, io, { openEngine: async () => engine, env: {}, literature: { fetch: fakeFetch, sleep: async () => {} } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("re literature (M7)", () => {
  it("searches the chosen sources, merges duplicates, and reports each source's status", async () => {
    const r = await re(["literature", "search", "SZ3", "modular", "compression", "--sources", "openalex,crossref,s2", "--from", "2020"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/openalex ok \(1\), crossref ok \(1\), s2 throttled/);
    expect(r.err).toMatch(/s2: .*429.*re literature key s2/);
    const lines = r.out.split("\n").filter((l) => l.includes("SZ3:"));
    expect(lines).toHaveLength(1); // one paper, found by two sources
    expect(lines[0]).toMatch(/^2023 {2}doi:10\.1109\/tbdata\.2022\.3201176 .*\[openalex,crossref\]$/);
    // The contact address goes to OpenAlex and Crossref only; the year filter reaches the sources.
    for (const c of calls) {
      const sent = `${c.url.toString()} ${JSON.stringify(c.headers)}`.includes("someone@university.edu") || decodeURIComponent(c.url.search).includes("someone@university.edu");
      expect(sent).toBe(c.url.host === "api.openalex.org" || c.url.host === "api.crossref.org");
    }
    expect(calls.find((c) => c.url.host === "api.openalex.org")!.url.searchParams.get("filter")).toMatch(/^publication_year:2020-\d{4}$/);
    expect(await re(["literature", "search", "x", "--sources", "scholar"])).toMatchObject({ code: 1, err: expect.stringMatching(/unknown source scholar/) });
  });

  it("resolves a DOI to verified BibTeX; an unregistered DOI gets none", async () => {
    const r = await re(["literature", "resolve", `https://doi.org/${SZ3_DOI}`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^resolved: liang2023sz3$/m);
    expect(r.out).toMatch(/check: doi\.org: 10\.1109\/tbdata\.2022\.3201176 is registered/);
    expect(r.out).toContain("@article{liang2023sz3,");
    const bad = await re(["literature", "resolve", "10.9999/made.up.2024"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/^not_found/);
    expect(bad.out).not.toContain("@");
  });

  it("resolves a title only to a single close match, then by its DOI", async () => {
    const r = await re(["literature", "resolve", "--title", "SZ3: A modular framework for composing prediction-based error-bounded lossy compressors", "--year", "2023", "--author", "Liang"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/title search .*1 close/);
    expect(r.out).toContain("@article{liang2023sz3,");
    const vague = await re(["literature", "resolve", "--title", "Lossy compression for scientific data at scale"]);
    expect(vague.code).toBe(1);
    expect(vague.out).toMatch(/^inconclusive/);
    expect(vague.out).toMatch(/candidate: 2023/);
    expect(vague.out).not.toContain("@article");
  });

  it("caches responses in the engine home without the contact address", async () => {
    await re(["literature", "fetch", `doi:${SZ3_DOI}`]);
    const crossref = () => calls.filter((c) => c.url.host === "api.crossref.org").length;
    expect(crossref()).toBe(1);
    const again = await re(["literature", "fetch", `doi:${SZ3_DOI}`]);
    expect(again.out).toMatch(/authors: Liang, Xin; Zhao, Kai/);
    expect(crossref()).toBe(1); // answered from the cache (only 200s are cached; misses are asked again)
    const dir = join(engine.paths.home, "literature-cache");
    for (const f of await readdir(dir)) expect(await readFile(join(dir, f), "utf8")).not.toContain("someone@university.edu");
  });

  it("stores the Semantic Scholar key in the secrets folder (0600) and sends it only to Semantic Scholar", async () => {
    expect((await re(["literature", "key", "s2"], "short")).code).toBe(1);
    expect((await re(["literature", "key", "s2"], "abcDEF0123456789abcdef")).code).toBe(0);
    expect(await readLiteratureKeys(engine.paths.home)).toEqual({ s2: "abcDEF0123456789abcdef" });
    expect((await stat(join(engine.paths.home, "secrets", "literature.json"))).mode & 0o777).toBe(0o600);
    await re(["literature", "search", "sz3 compressor", "--sources", "s2,crossref"]);
    for (const c of calls) expect(JSON.stringify(c.headers).includes("abcDEF0123456789abcdef")).toBe(c.url.host === "api.semanticscholar.org");
    expect(calls.some((c) => c.url.host === "api.semanticscholar.org")).toBe(true);
    expect((await re(["literature", "key", "s2", "--clear"])).code).toBe(0);
    expect(await readLiteratureKeys(engine.paths.home)).toEqual({});
  });
});
