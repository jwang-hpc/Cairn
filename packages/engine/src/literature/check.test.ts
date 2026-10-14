import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citekey, LitHttp, LiteratureService, toBibtex, type PaperRecord } from "@cairn/executor";
import { git } from "@cairn/launcher";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { envelope } from "../events/log.js";
import { Ledger } from "../ledger/ledger.js";
import { checkLiterature, citationsIn, frontmatter, mergePreprints, paperNotes, parseBibtex } from "./check.js";

const SZ3 = "10.1109/tbdata.2022.3201176";
const TOPOSZ_DOI = "10.1109/tvcg.2023.1234";
const CROSSREF: Record<string, unknown> = {
  [TOPOSZ_DOI]: {
    DOI: TOPOSZ_DOI,
    title: ["TopoSZ: Preserving Topology in Error-Bounded Lossy Compression"],
    author: [{ given: "Lin", family: "Yan" }],
    issued: { "date-parts": [[2023]] },
    "container-title": ["IEEE TBD"],
    type: "journal-article",
  },
  [SZ3]: {
    DOI: SZ3,
    title: ["SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors"],
    author: [{ given: "Xin", family: "Liang" }, { given: "Kai", family: "Zhao" }],
    issued: { "date-parts": [[2023]] },
    "container-title": ["IEEE Transactions on Big Data"],
    type: "journal-article",
  },
};
const ARXIV_TOPOSZ = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/2304.11768v2</id><title>TopoSZ: Preserving Topology in Error-Bounded Lossy Compression</title>
  <summary>Topology.</summary><published>2023-04-23T23:25:01Z</published><author><name>Lin Yan</name></author></entry></feed>`;
const EMPTY_FEED = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  const path = decodeURIComponent(`${url.host}${url.pathname}`);
  const handle = /^doi\.org\/api\/handles\/(.+)$/.exec(path)?.[1];
  if (handle) return CROSSREF[handle] ? json({ responseCode: 1 }) : json({ responseCode: 100 }, 404);
  const work = /^api\.crossref\.org\/works\/(.+)$/.exec(path)?.[1];
  if (work) return CROSSREF[work] ? json({ status: "ok", message: CROSSREF[work] }) : new Response("Resource not found.", { status: 404 });
  if (path === "api.openalex.org/works" || path.startsWith("api.openalex.org/works/")) return json({ results: [] }, path.endsWith("works") ? 200 : 404);
  if (path === "export.arxiv.org/api/query") {
    const body = url.searchParams.get("id_list") === "2304.11768" ? ARXIV_TOPOSZ : EMPTY_FEED;
    return new Response(body, { status: 200, headers: { "content-type": "application/atom+xml" } });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;
const lit = () => new LiteratureService(new LitHttp({ fetch: fakeFetch, sleep: async () => {} }));

const SZ3_RECORD: PaperRecord = {
  ids: { doi: SZ3 },
  title: "SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors",
  authors: ["Liang, Xin", "Zhao, Kai"],
  year: 2023,
  venue: "IEEE Transactions on Big Data",
  kind: "journal-article",
  sources: ["crossref"],
};
const TOPOSZ_RECORD: PaperRecord = { ids: { arxiv: "2304.11768" }, title: "TopoSZ: Preserving Topology in Error-Bounded Lossy Compression", authors: ["Lin Yan"], year: 2023, sources: ["arxiv"] };
const GOOD_BIB = toBibtex(SZ3_RECORD, citekey(SZ3_RECORD)) + "\n" + toBibtex(TOPOSZ_RECORD, citekey(TOPOSZ_RECORD));
const LOG = `${JSON.stringify({ key: "liang2023sz3" })}\n${JSON.stringify({ key: "yan2023toposz" })}\n`;
const SECTIONS = "## Problem\nx\n## Method\nx\n## Setup\nx\n## Key numbers\nx\n## Limitations\nx\n## Artifact\nx\n## Relevance\nx\n";
const note = (paper: string, body = SECTIONS, relevance: unknown = 8) =>
  `---\npaper: ${paper}\n${relevance === null ? "" : `relevance: ${JSON.stringify(relevance)}\n`}---\n# T\n\n${body}`; // null: no score
const fails = (r: { items: { level: string; where: string; message: string }[] }) => r.items.filter((i) => i.level === "fail").map((i) => `${i.where}: ${i.message}`);

describe("BibTeX and citation parsing", () => {
  it("reads what resolve writes and what a hand might write", () => {
    const { entries, errors } = parseBibtex(`${GOOD_BIB}\n@misc{hand, title = "Quoted {Nested} Title", year = 2020, note = {a {b} c}}\n@broken{`);
    expect(entries.map((e) => [e.type, e.key])).toEqual([["article", "liang2023sz3"], ["misc", "yan2023toposz"], ["misc", "hand"]]);
    expect(entries[0]!.fields).toMatchObject({ title: `{${SZ3_RECORD.title}}`, doi: SZ3, year: "2023", author: "Liang, Xin and Zhao, Kai" });
    expect(entries[2]!.fields).toEqual({ title: "Quoted {Nested} Title", year: "2020", note: "a {b} c" });
    expect(errors).toEqual([expect.stringMatching(/not a BibTeX entry|malformed/)]);
  });

  it("finds pandoc and LaTeX citations", () => {
    expect(citationsIn("As shown [@liang2023sz3; @yan2023toposz, p. 3] and \\cite{a1,b2}. Email x@y.org [see @k9].")).toEqual(["liang2023sz3", "yan2023toposz", "k9", "a1", "b2"]);
  });
});

describe("checkLiterature (re-verifies, never trusts the log)", () => {
  it("passes resolved entries and notes that cite them", async () => {
    const r = await checkLiterature(
      { refs: GOOD_BIB, resolutions: LOG, notes: [{ path: "lit/notes/liang2023sz3.md", text: note(`doi:${SZ3}`) }, { path: "lit/notes/related-work.md", text: "SZ3 [@liang2023sz3] and TopoSZ [@yan2023toposz]." }] },
      lit(),
    );
    expect(r).toMatchObject({ ok: true, references: 2, citations: 2, notes: 2 });
    expect(r.items).toEqual([]);
  });

  it("fails hand-made, altered, unsafe, and unresolvable entries, and dangling citations", async () => {
    const bib = [
      GOOD_BIB.replace("year = {2023}", "year = {2021}"), // altered year on SZ3
      "@article{fake2024made,\n  title = {{A Paper That Does Not Exist}},\n  author = {Doe, Jane},\n  year = {2024},\n  doi = {10.9999/made.up}\n}\n",
      "@misc{evil2023x,\n  title = {{X\\input{/etc/passwd}}},\n  eprint = {2304.11768}\n}\n",
      "@misc{wrong2023title,\n  title = {{Something Else Entirely}},\n  author = {Lin Yan},\n  year = {2023},\n  eprint = {2304.11768},\n  archivePrefix = {arXiv}\n}\n",
      "@article{noid2023,\n  title = {{No Identifier}},\n  note = {trust me}\n}\n",
    ].join("\n");
    const r = await checkLiterature({ refs: bib, resolutions: LOG, notes: [{ path: "lit/notes/x.md", text: "Uncited [@ghost2020]." }] }, lit());
    expect(r.ok).toBe(false);
    const f = fails(r).join("\n");
    expect(f).toMatch(/liang2023sz3: year 2021, but the record says 2023/);
    expect(f).toMatch(/fake2024made: doi 10\.9999\/made\.up does not resolve/);
    expect(f).toMatch(/evil2023x: field title holds LaTeX commands or braces/);
    expect(f).toMatch(/wrong2023title: title does not match arxiv 2304\.11768/);
    expect(f).toMatch(/noid2023: field note is not one literature\.resolve writes; neither a doi nor an arXiv eprint/);
    expect(f).toMatch(/lit\/notes\/x\.md: cites ghost2020, which is not in lit\/refs\.bib/);
    expect(r.items.filter((i) => i.level === "warn").map((i) => i.message)).toContain("verified, but not in lit/resolutions.jsonl (not added through literature.resolve)");
  });

  it("a preprint and its publication in one refs.bib are flagged, and merged into the publication", async () => {
    // TopoSZ's arXiv entry, and a "published" TopoSZ with the same title and first author.
    const PUB: PaperRecord = { ids: { doi: TOPOSZ_DOI }, title: TOPOSZ_RECORD.title, authors: ["Yan, Lin"], year: 2023, kind: "journal-article", venue: "IEEE TBD", sources: ["crossref"] };
    const pubBib = toBibtex(PUB, "yan2023topopub");
    const refs = `${toBibtex(TOPOSZ_RECORD, citekey(TOPOSZ_RECORD))}\n${pubBib}`;
    const notes = [
      { path: "lit/notes/yan2023toposz.md", text: "---\npaper: arxiv:2304.11768\nrelevance: 7\n---\n# TopoSZ [@yan2023toposz]\n" },
      { path: "lit/notes/related-work.md", text: "Topology [@yan2023toposz; @other2020] and \\cite{a,yan2023toposz}. Not [@yan2023toposzx].\n" },
    ];
    const pairs = (await checkLiterature({ refs, notes, resolutions: "" }, lit())).items.filter((i) => /arXiv preprint/.test(i.message));
    expect(pairs.map((i) => i.message)).toEqual(["the arXiv preprint of yan2023topopub (same paper): cite yan2023topopub; re literature accept merges them"]);
    const m = mergePreprints({ refs, notes, resolutions: "" }, new Date("2026-10-14T00:00:00Z"));
    expect(m.merges).toEqual([{ from: "yan2023toposz", into: "yan2023topopub", citations: 3, note: "renamed" }]);
    expect(m.removed).toEqual(["lit/notes/yan2023toposz.md"]);
    const bib = parseBibtex(m.files.refs);
    expect(bib.errors).toEqual([]);
    expect(bib.entries.map((e) => [e.key, e.fields.doi, e.fields.eprint])).toEqual([["yan2023topopub", TOPOSZ_DOI, "2304.11768"]]);
    expect(m.files.notes.map((n) => n.path)).toEqual(["lit/notes/yan2023topopub.md", "lit/notes/related-work.md"]);
    expect(m.files.notes[0]!.text).toContain(`paper: doi:${TOPOSZ_DOI}\n`);
    expect(m.files.notes[1]!.text).toBe("Topology [@yan2023topopub; @other2020] and \\cite{a,yan2023topopub}. Not [@yan2023toposzx].\n");
    expect(m.files.resolutions).toBe('{"at":"2026-10-14T00:00:00.000Z","merged":"yan2023toposz","into":"yan2023topopub","by":"re literature accept"}\n');
  });

  it("paper notes carry a 0-10 relevance score: missing is a warning, malformed a failure", async () => {
    const r = await checkLiterature(
      {
        refs: GOOD_BIB,
        resolutions: LOG,
        notes: [
          { path: "lit/notes/liang2023sz3.md", text: note(`doi:${SZ3}`, SECTIONS, null) },
          { path: "lit/notes/yan2023toposz.md", text: note("arxiv:2304.11768", SECTIONS, "high") },
        ],
      },
      lit(),
    );
    expect(fails(r)).toEqual(['lit/notes/yan2023toposz.md: relevance must be an integer from 0 to 10, not "high"']);
    expect(r.items.filter((i) => i.level === "warn").map((i) => `${i.where}: ${i.message}`)).toEqual(["lit/notes/liang2023sz3.md: no relevance score (relevance: 0-10 in the frontmatter)"]);
    expect(paperNotes([
      { path: "lit/notes/a2020x.md", text: note("doi:10.1/a", SECTIONS, 4) },
      { path: "lit/notes/b2021y.md", text: note("doi:10.1/b", SECTIONS, 9) },
      { path: "lit/notes/c2022z.md", text: note("doi:10.1/c", SECTIONS, 11) },
      { path: "lit/notes/related-work.md", text: "no frontmatter [@a2020x]" },
    ]).map((n) => [n.key, n.relevance])).toEqual([["b2021y", 9], ["a2020x", 4], ["c2022z", undefined]]);
  });

  it("reads frontmatter whose title holds a colon (agents don't quote it)", async () => {
    // As the literature agent wrote it in the M7 acceptance run (2026-10-14).
    const text = `---\npaper: doi:${SZ3}\ntitle: SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors\nyear: 2023\nbased_on: abstract and metadata\nrelevance: 9\nscholar: https://scholar.google.com/scholar?q=SZ3%3A+A\n---\n# SZ3\n\n${SECTIONS}`;
    expect(frontmatter(text)).toEqual({
      paper: `doi:${SZ3}`,
      title: "SZ3: A Modular Framework for Composing Prediction-Based Error-Bounded Lossy Compressors",
      year: 2023,
      based_on: "abstract and metadata",
      relevance: 9,
      scholar: "https://scholar.google.com/scholar?q=SZ3%3A+A",
    });
    expect(frontmatter('---\ntitle: "Quoted: fine"\nrelevance: 7\n---\n')).toEqual({ title: "Quoted: fine", relevance: 7 });
    expect(frontmatter("no frontmatter")).toBeUndefined();
    const r = await checkLiterature({ refs: GOOD_BIB, resolutions: LOG, notes: [{ path: "lit/notes/liang2023sz3.md", text }] }, lit());
    expect(r.items.filter((i) => /relevance/.test(i.message))).toEqual([]);
    expect(paperNotes([{ path: "lit/notes/liang2023sz3.md", text }])).toMatchObject([{ key: "liang2023sz3", relevance: 9, year: 2023, title: expect.stringMatching(/^SZ3: A Modular/) }]);
  });

  it("paper notes are named after their entry and name the same work", async () => {
    const r = await checkLiterature(
      {
        refs: GOOD_BIB,
        resolutions: LOG,
        notes: [
          { path: "lit/notes/liang2023sz3.md", text: note("arxiv:2304.11768", "## Problem\nonly this\n") },
          { path: "lit/notes/someone2020.md", text: note("doi:10.1/x") },
        ],
      },
      lit(),
    );
    expect(fails(r)).toEqual([
      "lit/notes/liang2023sz3.md: paper: arxiv:2304.11768 is not the work liang2023sz3 names in lit/refs.bib",
      "lit/notes/someone2020.md: a paper note must be lit/notes/<citekey>.md for a key in lit/refs.bib",
    ]);
    expect(r.items.find((i) => i.where === "lit/notes/liang2023sz3.md" && i.level === "warn")?.message).toBe("missing sections: Method, Setup, Key numbers, Limitations, Artifact");
  });
});

describe("re literature check <branch>", () => {
  let root: string;
  let engine: Engine;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cairn-lit-check-"));
    const cfg: LoadedConfig = {
      dir: "(test)",
      models: { providers: {}, models: {}, effort_map: {}, routing: {}, projects_default_data_class: "unpublished" },
      roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
      machines: { machines: {} },
      engine: { machine: "test", projects_dir: join(root, "projects"), budget: { daily: { usd: { total: 1 }, tokens: {} }, run: { max_usd: 1, max_tokens: 1000, max_turns: 2 } } },
    };
    const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
    engine = new Engine(cfg, { configDir: "(test)", home: join(root, "home") }, { models: { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) }, stores });
    await Ledger.create({ projectsDir: join(root, "projects"), name: "demo", title: "Demo", dataClass: "unpublished" });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function re(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: { CAIRN_PROJECT: "demo" }, literature: { fetch: fakeFetch, sleep: async () => {} } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("checks lit/ as committed on an agent branch, not the working tree", async () => {
    const dir = join(root, "projects", "demo");
    expect(await re("literature", "check")).toMatchObject({ code: 0, out: "ok: demo@HEAD: 0 references, 0 citations in 1 note files" });
    await git(dir, ["checkout", "-q", "-b", "agent/literature-1"]);
    await writeFile(join(dir, "lit", "refs.bib"), GOOD_BIB);
    await writeFile(join(dir, "lit", "resolutions.jsonl"), LOG);
    await mkdir(join(dir, "lit", "notes"), { recursive: true });
    await writeFile(join(dir, "lit", "notes", "related-work.md"), "SZ3 [@liang2023sz3]; TopoSZ [@yan2023toposz]; and [@ghost2020].\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lit"]);
    await git(dir, ["checkout", "-q", "main"]).catch(() => git(dir, ["checkout", "-q", "master"]));
    const r = await re("literature", "check", "agent/literature-1");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL {2}lit\/notes\/related-work\.md: cites ghost2020, which is not in lit\/refs\.bib/m);
    expect(r.out).toMatch(/FAILED: demo@agent\/literature-1: 2 references, 3 citations in 2 note files, 1 failures$/);
    await git(dir, ["checkout", "-q", "agent/literature-1"]);
    await writeFile(join(dir, "lit", "notes", "liang2023sz3.md"), `---\npaper: doi:${SZ3}\ntitle: SZ3\nyear: 2023\nrelevance: 9\n---\n`);
    await writeFile(join(dir, "lit", "notes", "yan2023toposz.md"), "---\npaper: arxiv:2304.11768\ntitle: TopoSZ\nyear: 2023\nrelevance: 6\n---\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "notes"]);
    await git(dir, ["checkout", "-q", "-"]);
    expect((await re("literature", "notes", "agent/literature-1")).out).toBe(" 9  liang2023sz3             2023  SZ3\n 6  yan2023toposz            2023  TopoSZ");
    expect((await re("literature", "notes")).out).toBe("(no paper notes)");
    expect((await re("literature", "check", "--upload-pack=evil")).code).not.toBe(0);
    expect(await re("literature", "check", "-x")).toMatchObject({ code: 2 });
  });

  const usage = (run: string) =>
    JSON.stringify({
      ...envelope(run, "test"),
      type: "usage",
      provider: "anthropic",
      route: "anthropic",
      auth: "oauth",
      model: "claude-opus-5-5",
      role: "literature",
      effort: "high",
      nativeEffort: {},
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: { usd: 0, kind: "notional" },
      durationMs: 1,
      stopReason: "stop",
      error: null,
    });

  async function agentBranch(dir: string, branch: string, files: Record<string, string>, run = "run-lit-1") {
    const main = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    await git(dir, ["checkout", "-q", "-b", branch]);
    for (const [p, c] of Object.entries(files)) {
      await mkdir(join(dir, p, ".."), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `agent literature-1 (literature): notes\n\nCairn-Run: ${run}\nCairn-Status: done\n`]);
    await git(dir, ["checkout", "-q", main]);
  }

  it("accept writes a checked branch's lit/ as one tagged ledger commit; ledger check stays clean", async () => {
    const dir = join(root, "projects", "demo");
    await mkdir(engine.paths.home, { recursive: true });
    await appendFile(join(engine.paths.home, "usage.jsonl"), `${usage("run-lit-1")}\n`);
    const good = {
      "lit/refs.bib": GOOD_BIB,
      "lit/resolutions.jsonl": LOG,
      "lit/notes/liang2023sz3.md": note(`doi:${SZ3}`),
      "lit/notes/related-work.md": "SZ3 [@liang2023sz3]; TopoSZ [@yan2023toposz].\n",
      "lit/notes/yan2023toposz.md": note("arxiv:2304.11768"),
      "lit/scratch.txt": "not read by check\n",
    };
    await agentBranch(dir, "agent/lit-bad", { ...good, "lit/notes/related-work.md": "[@ghost2020]\n" });
    expect(await re("literature", "accept", "agent/lit-bad")).toMatchObject({ code: 1, out: expect.stringMatching(/nothing accepted$/) });
    await agentBranch(dir, "agent/lit-good", good);
    const r = await re("literature", "accept", "agent/lit-good");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/accepted into demo: lit\/refs\.bib, lit\/resolutions\.jsonl, lit\/notes\/liang2023sz3\.md, lit\/notes\/related-work\.md, lit\/notes\/yan2023toposz\.md \(ai-suggested\(claude-opus-5-5, high\)\)$/m);
    expect(r.err).toContain("not accepted (check doesn't read it): lit/scratch.txt");
    expect(await readFile(join(dir, "lit", "refs.bib"), "utf8")).toBe(GOOD_BIB);
    expect(await git(dir, ["log", "-1", "--format=%(trailers:key=Cairn-Provenance,valueonly)"])).toMatch(/ai-suggested\(claude-opus-5-5, high\)/);
    expect(await re("ledger", "check")).toMatchObject({ code: 0 });
    // A preprint accepted earlier, and later its publication: accept merges them, removing the old note.
    await appendFile(join(engine.paths.home, "usage.jsonl"), `${usage("run-lit-2")}\n`);
    const PUB: PaperRecord = { ids: { doi: TOPOSZ_DOI }, title: TOPOSZ_RECORD.title, authors: ["Yan, Lin"], year: 2023, kind: "journal-article", venue: "IEEE TBD", sources: ["crossref"] };
    await agentBranch(dir, "agent/lit-pub", {
      "lit/refs.bib": `${GOOD_BIB}\n${toBibtex(PUB, "yan2023topopub")}`,
      "lit/notes/related-work.md": "SZ3 [@liang2023sz3]; TopoSZ [@yan2023toposz]; published [@yan2023topopub].\n",
    }, "run-lit-2");
    const merged = await re("literature", "accept", "agent/lit-pub");
    expect(merged.code).toBe(0);
    expect(merged.out).toMatch(/^merge {2}yan2023toposz \(arXiv preprint\) into yan2023topopub \(published\): 1 citations rewritten, its note is now lit\/notes\/yan2023topopub\.md$/m);
    expect(merged.out).toMatch(/-lit\/notes\/yan2023toposz\.md/);
    expect(await readFile(join(dir, "lit", "notes", "yan2023topopub.md"), "utf8")).toContain(`paper: doi:${TOPOSZ_DOI}`);
    expect(await readFile(join(dir, "lit", "notes", "related-work.md"), "utf8")).toBe("SZ3 [@liang2023sz3]; TopoSZ [@yan2023topopub]; published [@yan2023topopub].\n");
    expect(parseBibtex(await readFile(join(dir, "lit", "refs.bib"), "utf8")).entries.map((e) => e.key)).toEqual(["liang2023sz3", "yan2023topopub"]);
    await expect(readFile(join(dir, "lit", "notes", "yan2023toposz.md"), "utf8")).rejects.toThrow();
    expect(await re("ledger", "check")).toMatchObject({ code: 0 });
    // A second branch that started before that accept is refused: lit/ moved under it.
    await git(dir, ["branch", "agent/lit-stale", "agent/lit-good~0"]);
    expect((await re("literature", "accept", "agent/lit-stale")).err).toMatch(/lit\/ changed in demo since agent\/lit-stale started/);
  });
});
