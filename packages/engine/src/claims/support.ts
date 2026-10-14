// The code-only support check of the claim gate (DR-0007 step 1). Every Sources entry is opened in the ledger as
// committed — not the working copy, so nothing written moments ago by an agent counts — and the quoted line, the
// value in it, and the claim's numbers are compared by code. No model takes part; it cannot create a match.
// Support is not correctness: the report says what was checked and what was not.
import type { ClaimDraft, CoverageCheck, SourceCheck, SourceEntry, SupportReport } from "@cairn/shared";
import { lineNumbers, proseNumbers, sameNumber } from "./numbers.js";

/** Read-only view of the ledger as committed. */
export interface SourceReader {
  /** Commit the reads come from. */
  revision(): Promise<string>;
  /** File content at that commit, or undefined if the file isn't committed there. */
  read(path: string): Promise<string | undefined>;
  /** Exploration-tree node fields, or undefined. */
  node(id: string): Promise<Record<string, unknown> | undefined>;
}

/** Results come only from what parsers and the executor wrote (DR-0007); inputs may also come from code and configs. */
export const RESULT_ROOTS = ["evidence/", "engine/jobs/"] as const;
export const INPUT_ROOTS = [...RESULT_ROOTS, "experiments/", "src/", "logic/", "configs/"] as const;
/** Fields whose numbers must all be backed by a checked source. */
export const COVERED_FIELDS = ["Statement", "Conditions", "Proof"] as const;

const clean = (s: string) => s.replace(/\r$/, "").replace(/\s+$/, "");
const safePath = (p: string) => !p.startsWith("/") && !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");

interface Checked {
  entry: SourceEntry;
  status: SourceCheck;
  detail: string;
}

async function checkSource(e: SourceEntry, reader: SourceReader, warnings: string[]): Promise<Checked> {
  const fail = (detail: string): Checked => ({ entry: e, status: "failed", detail });
  if (e.pending !== undefined) return { entry: e, status: "pending", detail: `pending: ${e.pending}` };
  if (!e.ref || e.quote === undefined || !e.tag) return fail("incomplete entry");
  const quote = clean(e.quote);

  let line: string;
  let where: string;
  if (e.ref.kind === "file") {
    const { path, line: n } = e.ref;
    if (!safePath(path)) return fail(`${path}: not a project-relative path`);
    const roots = e.tag === "result" ? RESULT_ROOTS : INPUT_ROOTS;
    if (!roots.some((r) => path.startsWith(r))) {
      return fail(`${path}: ${e.tag === "result" ? "results must come from evidence/ or executor records (engine/jobs/)" : `inputs must come from ${INPUT_ROOTS.join(", ")}`}`);
    }
    const content = await reader.read(path);
    if (content === undefined) return fail(`${path} is not in the ledger (not committed)`);
    const lines = content.split("\n").map(clean);
    if (n < 1 || n > lines.length) return fail(`${path} has ${lines.length} lines, no line ${n}`);
    line = lines[n - 1]!;
    where = `${path}:${n}`;
    if (line !== quote) {
      const at = lines.findIndex((l) => l === quote);
      return fail(`${where} reads «${line}», not the quoted «${quote}»${at === -1 ? "" : ` (the quote is at line ${at + 1})`}`);
    }
  } else {
    const node = await reader.node(e.ref.node);
    if (!node) return fail(`no trace node ${e.ref.node}`);
    const text = node[e.ref.field];
    if (typeof text !== "string") return fail(`${e.ref.node} has no field ${e.ref.field}`);
    if (!text.includes(quote)) return fail(`${e.ref.node}.${e.ref.field} does not contain «${quote}»`);
    line = quote;
    where = `${e.ref.node}.${e.ref.field}`;
    if (e.tag === "result") warnings.push(`${e.value}: a result cited from trace node ${e.ref.node} (prose), not from evidence/`);
  }

  const found = lineNumbers(line);
  const match = found.map((t) => ({ t, how: sameNumber(e.value, t) })).find((x) => x.how !== undefined);
  if (!match) return fail(`${e.value} is not in ${where} (numbers there: ${found.join(", ") || "none"})`);
  if (match.how === "rounded") return { entry: e, status: "rounded", detail: `${where} has ${match.t}; ${e.value} is its rounding` };
  return { entry: e, status: "ok", detail: where };
}

export async function checkSupport(draft: ClaimDraft, reader: SourceReader, now: Date = new Date()): Promise<SupportReport> {
  const errors = [...draft.problems];
  const warnings: string[] = [];
  const revision = await reader.revision();
  const results: Checked[] = [];
  for (const e of draft.sources) results.push(await checkSource(e, reader, warnings));
  for (const r of results) {
    if (r.status === "failed") errors.push(`source ${r.entry.value}: ${r.detail}`);
    if (r.status === "pending") errors.push(`source ${r.entry.value} is pending (${r.entry.pending}); a claim with pending sources can't pass`);
  }

  // Coverage: every number in the claim's prose is backed by a source that checked out.
  const good = results.filter((r) => r.status === "ok" || r.status === "rounded");
  const coverage: SupportReport["coverage"] = [];
  for (const field of COVERED_FIELDS) {
    const nums = proseNumbers(draft.fields[field] ?? "");
    if (field === "Statement" && nums.length > 0) warnings.push(`the Statement carries numbers (${nums.join(", ")}); ARA keeps run numbers in Conditions and Proof`);
    for (const n of nums) {
      let status: CoverageCheck = "uncovered";
      let source: string | undefined;
      for (const r of good) {
        const how = sameNumber(n, r.entry.value);
        if (how) {
          status = how;
          source = r.entry.value;
          if (how === "exact") break;
        }
      }
      coverage.push({ field, number: n, status, ...(source ? { source } : {}) });
      if (status === "uncovered") {
        const bad = results.find((r) => r.status !== "ok" && r.status !== "rounded" && sameNumber(n, r.entry.value));
        errors.push(`${field}: ${n} is not backed by a checked source${bad ? ` (its source ${bad.status === "pending" ? "is pending" : "failed"})` : ""}`);
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
      `results only from ${RESULT_ROOTS.join(" or ")}; inputs from ${INPUT_ROOTS.join(", ")}`,
      `${coverage.length} number${coverage.length === 1 ? "" : "s"} in ${COVERED_FIELDS.join(", ")}: each backed by a checked source (exact, or a rounding of it)`,
    ],
    notChecked: [
      "whether the Statement follows from these numbers (rigor review, then you)",
      "whether the experiment was sound: baselines, repeats, controls, noise",
      "numbers written as words, and identifiers in `code spans` (ids, versions, paths)",
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
    ...(r.coverage.length ? r.coverage.map((c) => `  ${mark[c.status]}  ${c.field}: ${c.number}${c.source ? ` → ${c.source}` : ""}`) : ["  (no numbers)"]),
    ...(r.errors.length ? ["errors:", ...r.errors.map((e) => `  - ${e}`)] : []),
    ...(r.warnings.length ? ["warnings:", ...r.warnings.map((w) => `  - ${w}`)] : []),
    "checked:",
    ...r.checked.map((c) => `  - ${c}`),
    "not checked:",
    ...r.notChecked.map((c) => `  - ${c}`),
  ].join("\n");
}
