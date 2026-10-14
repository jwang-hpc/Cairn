// Rigor review (DR-0007 step 2): one tool-less call to a reviewer model — by default routing.analysis.reviewer, a
// different vendor from the analysis worker — with the claim-level criteria of the vendored ARA rigor-reviewer skill
// (D1 evidence relevance, D2 falsifiability, D3 scope calibration, D6 methodological rigor), read verbatim from
// skills/third_party and never edited. The call goes through the model layer, so the project's data class, the
// budget, and the event log all apply. The review is advice for the user; it can't approve anything.
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimDraft, EffortLevel, SupportReport } from "@cairn/shared";
import type { Engine } from "../engine.js";
import type { Ledger } from "../ledger/ledger.js";
import { REPO_ROOT } from "../paths.js";
import type { SourceReader } from "./support.js";
import { renderReport } from "./support.js";

export const REVIEW_DIMENSIONS = { D1: "evidence_relevance", D2: "falsifiability", D3: "scope_calibration", D6: "methodological_rigor" } as const;
const PACKET_MAX = 60_000;
const SOURCE_FILE_MAX = 8_000;

export interface DimensionReview {
  score: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

export interface ClaimReview {
  draft_sha256: string;
  reviewer: { alias: string; model: string; effort: EffortLevel };
  at: string;
  run: string;
  verdict: "ready" | "revise" | "reject" | "unparsed";
  summary: string;
  dimensions: Partial<Record<(typeof REVIEW_DIMENSIONS)[keyof typeof REVIEW_DIMENSIONS], DimensionReview>>;
  findings: { severity: "critical" | "major" | "minor"; issue: string; suggestion: string }[];
  /** The model's text when it wasn't the requested JSON. */
  raw?: string;
}

export const draftSha = (md: string) => createHash("sha256").update(md).digest("hex");

/** The vendored skill's criteria sections, verbatim ("#### D1. …" up to the next "####" or "###"). */
export async function rigorCriteria(root = join(REPO_ROOT, "skills", "third_party")): Promise<{ text: string; source: string }> {
  const ara = (await readdir(root)).filter((d) => d.startsWith("ara@")).sort().at(-1);
  if (!ara) throw new Error("the ARA skills are not vendored under skills/third_party");
  const source = join(root, ara, "rigor-reviewer", "SKILL.md");
  const md = await readFile(source, "utf8");
  const sections = Object.keys(REVIEW_DIMENSIONS).map((d) => {
    const m = new RegExp(`^#### ${d}\\. [\\s\\S]*?(?=^#{3,4} )`, "m").exec(md);
    if (!m) throw new Error(`${source}: no section ${d}`);
    return m[0].trim();
  });
  return { text: sections.join("\n\n"), source: `${ara}/rigor-reviewer/SKILL.md` };
}

/** Everything the reviewer sees: the project frame, the claim, the code check's report, and the cited files. */
export async function reviewPacket(ledger: Ledger, reader: SourceReader, md: string, draft: ClaimDraft, report: SupportReport): Promise<string> {
  const part = (title: string, body: string) => `## ${title}\n\n${body.trim()}\n`;
  const parts = [
    part("Project manifest (PAPER.md)", await ledger.read("PAPER.md")),
    part("Hypotheses (logic/hypotheses.md)", await ledger.read("logic/hypotheses.md")),
    part("Exploration tree (dead ends included)", `\`\`\`\n${await ledger.renderTree()}\n\`\`\``),
    part("The claim under review (draft)", md),
    part("Support check report (code only; already passed)", renderReport(report)),
  ];
  const files = [...new Set(draft.sources.flatMap((s) => (s.ref?.kind === "file" ? [s.ref.path] : [])))];
  for (const f of files) {
    const content = (await reader.read(f)) ?? "(not committed)";
    parts.push(part(`Cited file ${f}`, `\`\`\`\n${content.length > SOURCE_FILE_MAX ? `${content.slice(0, SOURCE_FILE_MAX)}\n[… ${content.length - SOURCE_FILE_MAX} more characters]` : content}\n\`\`\``));
  }
  const text = `# Claim review packet: ${ledger.name}\n\n${parts.join("\n")}`;
  return text.length > PACKET_MAX ? `${text.slice(0, PACKET_MAX)}\n\n[packet truncated at ${PACKET_MAX} characters]\n` : text;
}

export function reviewPrompt(criteria: string, packet: string): { system: string; user: string } {
  return {
    system: [
      "You review one research claim before it may enter a project's claims (logic/claims.md).",
      "Code has already checked that every number in the claim is in the cited files (see the support report). Your job is what code can't do: does the evidence substantively support the claim, is the falsification meaningful, is the scope calibrated to the evidence, and is the method sound.",
      "Ground every point in the packet. Never invent numbers, files, citations, or results. Be constructive and calibrated; don't approve to be agreeable.",
      "Criteria, verbatim from the ARA rigor-reviewer skill (apply them to this one claim):",
      criteria,
    ].join("\n\n"),
    user: [
      packet,
      "Respond with one JSON object and nothing else:",
      '{"dimensions": {"evidence_relevance": {"score": 1-5, "strengths": [], "weaknesses": [], "suggestions": []}, "falsifiability": {…}, "scope_calibration": {…}, "methodological_rigor": {…}},',
      ' "findings": [{"severity": "critical" | "major" | "minor", "issue": "…", "suggestion": "…"}],',
      ' "verdict": "ready" | "revise" | "reject", "summary": "two or three sentences"}',
    ].join("\n"),
  };
}

/** Parse the reviewer's JSON (the first {...} block); anything else is kept raw with verdict "unparsed". */
export function parseReview(text: string): Pick<ClaimReview, "verdict" | "summary" | "dimensions" | "findings" | "raw"> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Partial<ClaimReview>;
    const verdict = j.verdict === "ready" || j.verdict === "revise" || j.verdict === "reject" ? j.verdict : "unparsed";
    const dims: ClaimReview["dimensions"] = {};
    for (const key of Object.values(REVIEW_DIMENSIONS)) {
      const d = (j.dimensions as Record<string, Partial<DimensionReview>> | undefined)?.[key];
      if (d && typeof d.score === "number") {
        dims[key] = { score: Math.max(1, Math.min(5, Math.round(d.score))), strengths: d.strengths ?? [], weaknesses: d.weaknesses ?? [], suggestions: d.suggestions ?? [] };
      }
    }
    const findings = (j.findings ?? []).filter((f) => f && ["critical", "major", "minor"].includes(f.severity) && typeof f.issue === "string");
    return { verdict, summary: typeof j.summary === "string" ? j.summary : "", dimensions: dims, findings, ...(verdict === "unparsed" ? { raw: text } : {}) };
  } catch {
    return { verdict: "unparsed", summary: "", dimensions: {}, findings: [], raw: text };
  }
}

export function renderReview(r: ClaimReview): string {
  const dims = Object.entries(r.dimensions).map(([k, d]) => `  ${k.padEnd(22)} ${d.score}/5${d.weaknesses.length ? ` — ${d.weaknesses[0]}` : ""}`);
  return [
    `rigor review: ${r.verdict.toUpperCase()} — ${r.reviewer.alias} (${r.reviewer.model}, ${r.reviewer.effort}) · ${r.at}`,
    ...(r.summary ? [`summary: ${r.summary}`] : []),
    ...(dims.length ? ["dimensions:", ...dims] : []),
    ...(r.findings.length ? ["findings:", ...r.findings.map((f) => `  [${f.severity}] ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ""}`)] : []),
    ...(r.raw ? ["(the reviewer did not answer in the requested format; its text is kept in the review record)"] : []),
  ].join("\n");
}

/** The reviewer could not be asked or did not answer (unknown alias, provider refused the data class, call failed). */
export class ReviewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerError";
  }
}

/** One reviewer call through the model layer (data class, budget, event log). */
export async function callReviewer(
  engine: Engine,
  ledger: Ledger,
  who: { alias: string; effort: EffortLevel },
  prompt: { system: string; user: string },
): Promise<{ text: string; run: string; model: string }> {
  const run = randomUUID();
  const model = engine.config.models.models[who.alias]?.id;
  if (!model) throw new ReviewerError(`unknown model alias '${who.alias}'`);
  const budget = await engine.governor.startRun("review", run);
  const s = await engine.layer.stream(
    { alias: who.alias, effort: who.effort, role: "review", dataClass: ledger.dataClass, run: budget },
    { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] },
  );
  for await (const _ of s) {
    // drain; the final message carries the text or the error
  }
  const final = await s.result();
  if (final.stopReason === "error" || final.stopReason === "aborted") throw new ReviewerError(`reviewer call failed: ${final.errorMessage ?? final.stopReason}`);
  return { text: final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim(), run, model };
}
