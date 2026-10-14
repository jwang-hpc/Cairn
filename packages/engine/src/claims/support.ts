// The code-only support check of the claim gate (DR-0007 step 1). Every Sources entry is opened in the ledger as
// committed — not the working copy, so nothing written moments ago by an agent counts — and the quoted line, the
// value in it, and the claim's numbers are compared by code. No model takes part; it cannot create a match.
// Support is not correctness: the report says what was checked and what was not.
import type { ClaimDraft, CoverageCheck, SourceCheck, SourceEntry, SupportReport } from "@cairn/shared";
import { lineNumbers, numberTokens, proseNumbers, sameNumber } from "./numbers.js";

/** Read-only view of the ledger as committed. */
export interface SourceReader {
  /** Commit the reads come from. */
  revision(): Promise<string>;
  /** File content at that commit, or undefined if the file isn't committed there. */
  read(path: string): Promise<string | undefined>;
  /** Exploration-tree node fields, or undefined. */
  node(id: string): Promise<Record<string, unknown> | undefined>;
}

/**
 * Results come only from what ran: a job's declared outputs and log tails (evidence/raw/<EXP>/<job>/, as listed in
 * its MANIFEST.json) and parser tables (evidence/tables/). Not from job/ (the files the agent wrote), MANIFEST.json
 * (bookkeeping), or engine/jobs/ (job records carry the agent's description). Inputs may come from those and from
 * code and configs; the report shows each number's tag.
 */
export const INPUT_ROOTS = ["evidence/", "engine/jobs/", "experiments/", "src/", "logic/", "configs/"] as const;
/** Fields whose numbers must all be backed by a checked source (Title is the claim's heading). */
export const COVERED_FIELDS = ["Title", "Statement", "Conditions", "Proof"] as const;

const clean = (s: string) => s.replace(/\r$/, "").replace(/\s+$/, "");
const safePath = (p: string) => !p.startsWith("/") && !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
const JOB_EVIDENCE = /^evidence\/raw\/(EXP-\d{3,4})\/(\d{8}-\d{4}-[0-9a-f]{4})\/(.+)$/;

/** Why a path can't hold a [result], or undefined if it can. */
async function resultSource(path: string, reader: SourceReader): Promise<string | undefined> {
  if (path.startsWith("evidence/tables/")) return undefined;
  const m = JOB_EVIDENCE.exec(path);
  if (!m) return "results come only from a job's outputs (evidence/raw/<EXP>/<job>/) or parser tables (evidence/tables/)";
  const rest = m[3]!;
  if (rest.startsWith("job/")) return "job/ holds the files the agent wrote, not what the job produced; cite them as [input]";
  if (rest === "MANIFEST.json") return "MANIFEST.json is bookkeeping, not a result";
  let manifest: { files?: { path: string }[]; logs?: { path: string }[] };
  try {
    manifest = JSON.parse((await reader.read(`evidence/raw/${m[1]}/${m[2]}/MANIFEST.json`)) ?? "");
  } catch {
    return `no executor MANIFEST.json for job ${m[2]}`;
  }
  const declared = new Set([...(manifest.files ?? []).map((f) => f.path), ...(manifest.logs ?? []).map((l) => `logs/${l.path}`)]);
  return declared.has(rest) ? undefined : `${rest} is not an output the executor fetched for job ${m[2]}`;
}

interface Checked {
  entry: SourceEntry;
  status: SourceCheck;
  detail: string;
  /** The number in the file that the value matched (coverage compares against this, not the rounded value). */
  matched?: string;
}

async function checkSource(e: SourceEntry, reader: SourceReader): Promise<Checked> {
  const fail = (detail: string): Checked => ({ entry: e, status: "failed", detail });
  if (e.pending !== undefined) return { entry: e, status: "pending", detail: `pending: ${e.pending}` };
  if (!e.ref || e.quote === undefined || !e.tag) return fail("incomplete entry");
  const quote = clean(e.quote);

  let found: string[];
  let where: string;
  if (e.ref.kind === "file") {
    const { path, line: n } = e.ref;
    if (!safePath(path)) return fail(`${path}: not a project-relative path`);
    if (e.tag === "result") {
      const why = await resultSource(path, reader);
      if (why) return fail(`${path}: ${why}`);
    } else if (!INPUT_ROOTS.some((r) => path.startsWith(r))) {
      return fail(`${path}: inputs must come from ${INPUT_ROOTS.join(", ")}`);
    }
    const content = await reader.read(path);
    if (content === undefined) return fail(`${path} is not in the ledger (not committed)`);
    const lines = content.split("\n").map(clean);
    if (n < 1 || n > lines.length) return fail(`${path} has ${lines.length} lines, no line ${n}`);
    const line = lines[n - 1]!;
    where = `${path}:${n}`;
    if (line !== quote) {
      const at = lines.findIndex((l) => l === quote);
      return fail(`${where} reads «${line}», not the quoted «${quote}»${at === -1 ? "" : ` (the quote is at line ${at + 1})`}`);
    }
    found = lineNumbers(line, /\.(csv|tsv)$/i.test(path) ? "csv" : "text");
  } else {
    if (e.tag === "result") return fail(`${e.ref.node}: results come from evidence/, not from trace nodes (prose); cite the output`);
    const node = await reader.node(e.ref.node);
    if (!node) return fail(`no trace node ${e.ref.node}`);
    const text = node[e.ref.field];
    if (typeof text !== "string") return fail(`${e.ref.node} has no field ${e.ref.field}`);
    const at = text.indexOf(quote);
    if (at === -1 || quote === "") return fail(`${e.ref.node}.${e.ref.field} does not contain «${quote}»`);
    where = `${e.ref.node}.${e.ref.field}`;
    // Only whole numbers inside the quote count: "102" quoted from "1024 ranks" is not 102.
    found = numberTokens(text).filter((t) => t.start >= at && t.end <= at + quote.length).map((t) => t.text);
  }

  const match = found.map((t) => ({ t, how: sameNumber(e.value, t) })).find((x) => x.how !== undefined);
  if (!match) return fail(`${e.value} is not in ${where} (numbers there: ${found.join(", ") || "none"})`);
  if (match.how === "rounded") return { entry: e, status: "rounded", detail: `${where} has ${match.t}; ${e.value} is its rounding`, matched: match.t };
  return { entry: e, status: "ok", detail: where, matched: match.t };
}

export async function checkSupport(draft: ClaimDraft, reader: SourceReader, now: Date = new Date()): Promise<SupportReport> {
  const errors = [...draft.problems];
  const warnings: string[] = [];
  const revision = await reader.revision();
  const results: Checked[] = [];
  for (const e of draft.sources) results.push(await checkSource(e, reader));
  for (const r of results) {
    if (r.status === "failed") errors.push(`source ${r.entry.value}: ${r.detail}`);
    if (r.status === "pending") errors.push(`source ${r.entry.value} is pending (${r.entry.pending}); a claim with pending sources can't pass`);
  }

  // Coverage: every number in the claim's prose is backed by a source that checked out — compared with the number
  // in the file, so "4" can't ride on a source cited as "3.5" for 3.46.
  const good = results.filter((r) => r.matched !== undefined);
  const coverage: SupportReport["coverage"] = [];
  for (const field of COVERED_FIELDS) {
    const nums = proseNumbers(field === "Title" ? draft.title : (draft.fields[field] ?? ""));
    if (field === "Statement" && nums.length > 0) warnings.push(`the Statement carries numbers (${nums.join(", ")}); ARA keeps run numbers in Conditions and Proof`);
    for (const n of nums) {
      let best: { how: "exact" | "rounded"; r: Checked } | undefined;
      for (const r of good) {
        const how = sameNumber(n, r.matched!);
        if (how && (!best || (best.how === "rounded" && how === "exact") || (best.r.entry.tag === "input" && r.entry.tag === "result" && how === best.how))) best = { how, r };
      }
      coverage.push({ field, number: n, status: best?.how ?? "uncovered", ...(best ? { source: best.r.entry.value, tag: best.r.entry.tag! } : {}) });
      if (!best) {
        const bad = results.find((r) => r.matched === undefined && r.entry.value && sameNumber(n, r.entry.value));
        errors.push(`${field}: ${n} is not backed by a checked source${bad ? ` (its source ${bad.status === "pending" ? "is pending" : "failed"})` : ""}`);
      } else if (field === "Proof" && best.r.entry.tag === "input") {
        warnings.push(`Proof: ${n} is backed only by an [input] source; if it is a measured value, cite the job's output`);
      }
    }
  }
  const unused = good.filter((r) => !coverage.some((c) => c.source === r.entry.value));
  if (unused.length > 0) warnings.push(`sources not used by any number in the claim: ${unused.map((r) => r.entry.value).join(", ")}`);

  return {
    ok: errors.length === 0,
    title: draft.title,
    revision,
    checkedAt: now.toISOString(),
    sources: results.map((r) => ({ entry: r.entry.raw, value: r.entry.value, status: r.status, detail: r.detail })),
    coverage,
    errors,
    warnings,
    checked: [
      `${results.length} source${results.length === 1 ? "" : "s"} opened in the ledger as committed (${revision.slice(0, 12)}): file and line, the verbatim quote, and the value in it`,
      "results only from a job's fetched outputs or parser tables; inputs from evidence/, engine/jobs/, experiments/, src/, logic/, configs/ (each number's tag is shown)",
      `${coverage.length} number${coverage.length === 1 ? "" : "s"} in ${COVERED_FIELDS.join(", ")}: each backed by a checked source (the file's value, exactly or rounded)`,
      "the draft has no HTML comments, invisible characters, or non-ASCII digits",
    ],
    notChecked: [
      "whether the Statement follows from these numbers (rigor review, then you)",
      "whether the experiment was sound: baselines, repeats, controls, noise",
      "whether an [input] number is really an input (the tag is the drafter's; it is shown for each number)",
      "numbers written as words, and identifier-shaped code spans (`ids`, `paths`, `versions`)",
      "numbers in Falsification, Dependencies, and Tags",
    ],
  };
}

export function renderReport(r: SupportReport): string {
  const mark: Record<string, string> = { ok: "ok     ", rounded: "rounded", failed: "FAILED ", pending: "PENDING", exact: "exact  ", uncovered: "MISSING" };
  return [
    `support check: ${r.ok ? "PASSED" : "FAILED"} — ${r.title}`,
    `ledger commit ${r.revision.slice(0, 12)} · ${r.checkedAt}`,
    "sources:",
    ...r.sources.map((s) => `  ${mark[s.status]}  ${s.value}  ${s.detail}`),
    "coverage (numbers in the claim → source value):",
    ...(r.coverage.length ? r.coverage.map((c) => `  ${mark[c.status]}  ${c.field}: ${c.number}${c.source ? ` → ${c.source} [${c.tag}]` : ""}`) : ["  (no numbers)"]),
    ...(r.errors.length ? ["errors:", ...r.errors.map((e) => `  - ${e}`)] : []),
    ...(r.warnings.length ? ["warnings:", ...r.warnings.map((w) => `  - ${w}`)] : []),
    "checked:",
    ...r.checked.map((c) => `  - ${c}`),
    "not checked:",
    ...r.notChecked.map((c) => `  - ${c}`),
  ].join("\n");
}
