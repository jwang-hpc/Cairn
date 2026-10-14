// Multi-model panel (DR-0008, DR-0013). Members are (alias, effort) pairs from models.yaml; they see an identical
// context packet and are known to each other and to the user only by blind labels until the user records a
// judgment. Every member output is committed to engine/panels/<id>/ as ai-suggested(model, effort). Members are
// tool-less, so calls go straight through the model layer (budget, routes, data-class refusals all apply).
import { randomBytes, randomInt } from "node:crypto";
import { type DataClass, type EffortLevel, EFFORT_LEVELS, provenance } from "@cairn/shared";
import type { Engine } from "../engine.js";
import type { Ledger } from "../ledger/ledger.js";
import type { BudgetRun } from "../budget/governor.js";
import { buildPacket } from "./packet.js";
import {
  critiquePrompt,
  debateClosingPrompt,
  debateOpeningPrompt,
  debateTurnPrompt,
  independentPrompt,
  redteamPrompt,
  relayDraftPrompt,
  relayFinalPrompt,
  relayRevisePrompt,
  synthesisPrompt,
} from "./prompts.js";

export const ROUND_MODES = ["independent", "critique", "debate", "relay", "redteam", "synthesis"] as const;
export type RoundMode = (typeof ROUND_MODES)[number];

export interface MemberRef {
  alias: string;
  effort: EffortLevel;
}

export interface PanelSpec {
  question: string;
  hypothesis?: string;
  rounds: RoundMode[];
  members: MemberRef[];
  synthesizer?: MemberRef;
  /** debate: proposer/critic exchanges (1-4, default 2). */
  exchanges?: number;
  /** redteam: the venue the hostile reviewer reviews for, e.g. "SC" or "HPDC". */
  venue?: string;
}

export interface PanelMember {
  label: string;
  alias: string;
  model: string;
  provider: string;
  effort: EffortLevel;
}

export interface RoundOutput {
  label: string;
  /** Step within a multi-step round (relay: draft/revision/final; debate: opening/xN-critic/xN-proposer/closing). */
  step?: string;
  status: "ok" | "refused" | "error";
  file?: string;
  error?: string;
}

export interface PanelRecord {
  id: string;
  created: string;
  project: string;
  dataClass: string;
  question: string;
  hypothesis?: string;
  packet: { file: string; sha256: string; sources: string[] };
  /** Label -> model mapping. Hidden by the CLI until a judgment is recorded. */
  members: PanelMember[];
  synthesizer?: PanelMember;
  rounds: { n: number; mode: RoundMode; outputs: RoundOutput[] }[];
  warnings: string[];
  judgment?: { at: string; by: "user"; prefer: string[]; note?: string };
}

export class PanelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelError";
  }
}

const LABELS = "ABCDEFGHIJ";
const dir = (id: string) => `engine/panels/${id}`;

/** "claude-opus@high" -> { alias, effort } */
export function parseMemberRef(ref: string): MemberRef {
  const at = ref.lastIndexOf("@");
  const alias = at === -1 ? ref : ref.slice(0, at);
  const effort = (at === -1 ? "medium" : ref.slice(at + 1)) as EffortLevel;
  if (!alias || !(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new PanelError(`bad member ${JSON.stringify(ref)}; use alias@effort (effort: ${EFFORT_LEVELS.join("|")})`);
  return { alias, effort };
}

function resolveMember(engine: Engine, ref: MemberRef, label: string): PanelMember {
  const m = engine.config.models.models[ref.alias];
  if (!m) throw new PanelError(`unknown model alias '${ref.alias}' (known: ${Object.keys(engine.config.models.models).join(", ")})`);
  return { label, alias: ref.alias, model: m.id, provider: m.provider, effort: ref.effort };
}

/** Shape checks before any model is called. Returns warnings (recorded with the panel). */
export function validateSpec(engine: Engine, spec: PanelSpec): string[] {
  const warnings: string[] = [];
  if (spec.question.trim() === "") throw new PanelError("the panel needs a question");
  if (spec.members.length < 2) throw new PanelError("a panel needs at least two members");
  if (spec.members.length > LABELS.length) throw new PanelError(`at most ${LABELS.length} members`);
  const keys = spec.members.map((m) => `${m.alias}@${m.effort}`);
  if (new Set(keys).size !== keys.length) throw new PanelError("duplicate panel member");
  if (spec.rounds.length === 0) throw new PanelError("no rounds requested");
  const opener = spec.rounds[0]!;
  if (opener === "critique" || opener === "synthesis") throw new PanelError(`a panel cannot open with ${opener}; it needs answers to work on`);
  for (const [i, r] of spec.rounds.entries()) {
    if (!(ROUND_MODES as readonly string[]).includes(r)) throw new PanelError(`unknown round '${r}' (modes: ${ROUND_MODES.join(", ")})`);
    if (r === "critique" && !spec.rounds.slice(0, i).includes("independent")) throw new PanelError("critique needs an earlier independent round");
  }
  if (spec.rounds.includes("redteam") && !spec.venue?.trim()) throw new PanelError("redteam needs a venue (e.g. --venue SC)");
  if (spec.exchanges !== undefined && !(Number.isInteger(spec.exchanges) && spec.exchanges >= 1 && spec.exchanges <= 4)) throw new PanelError("debate exchanges must be 1-4");
  if ((spec.rounds.includes("relay") || spec.rounds.includes("debate")) && spec.members.length > 2) {
    warnings.push("relay and debate use the first two members (Model A and Model B); others sit those rounds out");
  }
  const synthAt = spec.rounds.indexOf("synthesis");
  if (synthAt !== -1 && synthAt !== spec.rounds.length - 1) throw new PanelError("synthesis must be the last round");
  if (spec.rounds.filter((r) => r === "synthesis").length > 1) throw new PanelError("only one synthesis round");

  const members = spec.members.map((m, i) => resolveMember(engine, m, `Model ${LABELS[i]}`));
  const vendors = new Set(members.map((m) => m.provider));
  if (vendors.size < 2) warnings.push(`single-vendor panel (${[...vendors][0]}); DR-0013 default is members from different vendors`);
  if (synthAt !== -1) {
    if (!spec.synthesizer) throw new PanelError("a synthesis round needs a synthesizer (a model outside the panel)");
    const s = resolveMember(engine, spec.synthesizer, "Synthesizer");
    if (members.some((m) => m.model === s.model)) throw new PanelError(`synthesizer ${s.alias} (${s.model}) is also a panel member; DR-0013 requires a model outside the panel`);
    if (vendors.has(s.provider)) warnings.push(`synthesizer shares vendor '${s.provider}' with a member; not vendor-neutral (M4 amendment, open questions 7/8)`);
  }
  return warnings;
}

interface Answer {
  text?: string;
  error?: string;
  refused: boolean;
}

async function ask(engine: Engine, run: BudgetRun, m: PanelMember, dataClass: DataClass, p: { system: string; user: string }): Promise<Answer> {
  const s = await engine.layer.stream(
    { alias: m.alias, effort: m.effort, role: "panel", dataClass, run },
    { systemPrompt: p.system, messages: [{ role: "user", content: p.user, timestamp: Date.now() }] },
  );
  for await (const _ of s) {
    // drain; the final message carries the text and any error
  }
  const final = await s.result();
  const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  if (final.stopReason === "error" || final.stopReason === "aborted") {
    const error = final.errorMessage ?? final.stopReason;
    return { error, refused: error.startsWith("refused:") };
  }
  if (text === "") return { error: "empty answer", refused: false };
  return { text, refused: false };
}

const header = (rec: PanelRecord, mode: RoundMode, label: string) =>
  `<!-- panel ${rec.id} · ${mode} · ${label} · ai-suggested; stays a suggestion until the user accepts it (DR-0007) -->\n\n`;

export async function runPanel(engine: Engine, ledger: Ledger, spec: PanelSpec, opts: { now?: () => Date } = {}): Promise<PanelRecord> {
  const now = opts.now ?? (() => new Date());
  const warnings = validateSpec(engine, spec);
  // Blind labels: a random order, so the label never reveals which vendor answered.
  const order = [...spec.members];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const members = order.map((m, i) => resolveMember(engine, m, `Model ${LABELS[i]}`));
  const synthesizer = spec.synthesizer ? resolveMember(engine, spec.synthesizer, "Synthesizer") : undefined;
  const t = now();
  const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}-${String(t.getHours()).padStart(2, "0")}${String(t.getMinutes()).padStart(2, "0")}`;
  const id = `${stamp}-${randomBytes(2).toString("hex")}`;
  const packet = await buildPacket(ledger, spec.hypothesis ? { hypothesis: spec.hypothesis } : {});
  const rec: PanelRecord = {
    id,
    created: t.toISOString(),
    project: ledger.name,
    dataClass: ledger.dataClass,
    question: spec.question,
    ...(spec.hypothesis ? { hypothesis: spec.hypothesis } : {}),
    packet: { file: `${dir(id)}/packet.md`, sha256: packet.sha256, sources: packet.sources },
    members,
    ...(synthesizer ? { synthesizer } : {}),
    rounds: [],
    warnings,
  };
  const json = () => ({ path: `${dir(id)}/panel.json`, content: `${JSON.stringify(rec, null, 2)}\n` });
  // The user asked for this panel: the packet and the run record are theirs.
  await ledger.writeArtifacts([{ path: rec.packet.file, content: packet.text }, json()], provenance.user, `panel ${id}: start (${spec.rounds.join(" → ")})`, "panel-start");

  const run = await engine.governor.startRun("panel", id);
  /** Every successful output so far, in order: what synthesis and later steps can see. */
  const transcript: { round: number; mode: RoundMode; label: string; step?: string; text: string }[] = [];
  const latestIndependent = () => {
    const r = [...rec.rounds].reverse().find((x) => x.mode === "independent");
    return new Map(transcript.filter((t) => r && t.round === r.n).map((t) => [t.label, t.text]));
  };
  const [first, second] = members as [PanelMember, PanelMember];

  for (const [i, mode] of spec.rounds.entries()) {
    const n = i + 1;
    const round: PanelRecord["rounds"][number] = { n, mode, outputs: [] };
    rec.rounds.push(round);
    /** Record one answer: failures go in the record; successes are committed under the member's own provenance. */
    const record = async (who: PanelMember, label: string, step: string | undefined, a: Answer): Promise<string | undefined> => {
      if (!a.text) {
        round.outputs.push({ label, ...(step ? { step } : {}), status: a.refused ? "refused" : "error", error: a.error ?? "no answer" });
        return undefined;
      }
      const file = `${dir(id)}/r${n}-${mode}/${step ? `${step}-` : ""}${label.replace(/^Model /, "")}.md`;
      round.outputs.push({ label, ...(step ? { step } : {}), status: "ok", file });
      transcript.push({ round: n, mode, label, ...(step ? { step } : {}), text: a.text });
      await ledger.writeArtifacts(
        [{ path: file, content: `${header(rec, mode, step ? `${label} (${step})` : label)}${a.text}\n` }, json()],
        provenance.aiSuggested(who.model, who.effort),
        `panel ${id}: ${mode}${step ? ` ${step}` : ""} ${label}`,
        "panel-output",
      );
      return a.text;
    };
    const say = async (who: PanelMember, step: string | undefined, prompt: { system: string; user: string }) =>
      record(who, who === synthesizer ? "synthesis" : who.label, step, await ask(engine, run, who, ledger.dataClass, prompt));

    switch (mode) {
      case "independent": {
        // Members answer in parallel; commits happen one at a time afterwards.
        const results = await Promise.all(members.map(async (m) => ({ m, a: await ask(engine, run, m, ledger.dataClass, independentPrompt(m.label, spec.question, packet.text)) })));
        for (const { m, a } of results) await record(m, m.label, undefined, a);
        break;
      }
      case "critique": {
        const prev = latestIndependent();
        const jobs = members.filter((m) => prev.has(m.label));
        const results = await Promise.all(
          jobs.map(async (m) => ({
            m,
            a: await ask(engine, run, m, ledger.dataClass, critiquePrompt(m.label, spec.question, packet.text, prev.get(m.label)!, [...prev].filter(([l]) => l !== m.label).map(([label, text]) => ({ label, text })))),
          })),
        );
        for (const { m, a } of results) await record(m, m.label, undefined, a);
        break;
      }
      case "relay": {
        const draft = await say(first, "draft", relayDraftPrompt(first.label, spec.question, packet.text));
        if (!draft) break;
        const revision = await say(second, "revision", relayRevisePrompt(second.label, spec.question, packet.text, first.label, draft));
        if (!revision) break;
        await say(first, "final", relayFinalPrompt(first.label, spec.question, packet.text, draft, second.label, revision));
        break;
      }
      case "debate": {
        const exchanges = spec.exchanges ?? 2;
        const opening = latestIndependent().get(first.label) ?? (await say(first, "opening", debateOpeningPrompt(first.label, spec.question, packet.text)));
        if (!opening) break;
        const history: { label: string; text: string }[] = [{ label: `${first.label} (proposer)`, text: opening }];
        let cut = false;
        for (let k = 1; k <= exchanges && !cut; k++) {
          const attack = await say(second, `x${k}-critic`, debateTurnPrompt(second.label, "critic", spec.question, packet.text, history));
          if (!attack) cut = true;
          else {
            history.push({ label: `${second.label} (critic)`, text: attack });
            const reply = await say(first, `x${k}-proposer`, debateTurnPrompt(first.label, "proposer", spec.question, packet.text, history));
            if (!reply) cut = true;
            else history.push({ label: `${first.label} (proposer)`, text: reply });
          }
        }
        for (const [who, role] of [[first, "proposer"], [second, "critic"]] as const) {
          await say(who, "closing", debateClosingPrompt(who.label, role, spec.question, packet.text, history));
        }
        break;
      }
      case "redteam": {
        const prior = transcript.map((t) => ({ label: `${t.label}${t.step ? ` (${t.step})` : ""}, round ${t.round} ${t.mode}`, text: t.text }));
        await say(first, "review", redteamPrompt(first.label, spec.venue!, spec.question, packet.text, prior));
        break;
      }
      case "synthesis": {
        const byRound = rec.rounds
          .filter((r) => r.n < n)
          .map((r) => ({
            title: `Round ${r.n}: ${r.mode}`,
            outputs: transcript.filter((t) => t.round === r.n).map((t) => ({ label: `${t.label}${t.step ? ` (${t.step})` : ""}`, text: t.text })),
          }));
        await say(synthesizer!, undefined, synthesisPrompt(spec.question, packet.text, byRound));
        break;
      }
    }
    if (!round.outputs.some((o) => o.status === "ok")) {
      rec.warnings.push(`round ${n} (${mode}) produced no answers; later rounds not run`);
      break;
    }
  }
  await ledger.writeArtifacts([json()], provenance.user, `panel ${id}: done`, "panel-done");
  return rec;
}

export async function readPanel(ledger: Ledger, id: string): Promise<{ record: PanelRecord; texts: Map<string, string> }> {
  if (!/^[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$/.test(id)) throw new PanelError(`bad panel id ${JSON.stringify(id)}`);
  let record: PanelRecord;
  try {
    record = JSON.parse(await ledger.read(`${dir(id)}/panel.json`)) as PanelRecord;
  } catch {
    throw new PanelError(`no panel ${id} in ${ledger.name}`);
  }
  const texts = new Map<string, string>();
  for (const r of record.rounds) for (const o of r.outputs) if (o.file) texts.set(o.file, await ledger.read(o.file));
  return { record, texts };
}

/** Record the user's judgment (unblinds the panel in the CLI). Human-only, like every judgment. */
export async function judgePanel(ledger: Ledger, id: string, j: { prefer: string[]; note?: string }, now: () => Date = () => new Date()): Promise<PanelRecord> {
  const { record } = await readPanel(ledger, id);
  if (record.judgment) throw new PanelError(`panel ${id} was already judged at ${record.judgment.at}`);
  const known = new Set(record.members.map((m) => m.label.replace(/^Model /, "")));
  for (const p of j.prefer) if (!known.has(p)) throw new PanelError(`--prefer ${p}: no such member (have ${[...known].join(", ")})`);
  record.judgment = { at: now().toISOString(), by: "user", prefer: j.prefer.map((p) => `Model ${p}`), ...(j.note ? { note: j.note } : {}) };
  await ledger.writeArtifacts([{ path: `${dir(id)}/panel.json`, content: `${JSON.stringify(record, null, 2)}\n` }], provenance.user, `panel ${id}: judged`, "panel-judge");
  return record;
}

/** Replay a stored panel as text. Labels stay blind until a judgment exists. */
export function renderPanel(record: PanelRecord, texts: Map<string, string>): string {
  const blind = !record.judgment;
  const who = (label: string) => {
    if (blind || label === "synthesis") return label;
    const m = record.members.find((x) => x.label === label);
    return m ? `${label} = ${m.alias} (${m.model}, ${m.provider}, ${m.effort})` : label;
  };
  const out = [
    `panel ${record.id} · project ${record.project} [${record.dataClass}]${record.hypothesis ? ` · ${record.hypothesis}` : ""}`,
    `question: ${record.question}`,
    `rounds:   ${record.rounds.map((r) => r.mode).join(" → ") || "(none)"}`,
    `members:  ${record.members.map((m) => who(m.label)).join("; ")}${blind ? "  (blind until `re panel judge`)" : ""}`,
    ...(record.synthesizer ? [`synth:    ${record.synthesizer.alias} (${record.synthesizer.model}, ${record.synthesizer.provider})`] : []),
    ...record.warnings.map((w) => `warning:  ${w}`),
    ...(record.judgment ? [`judged:   ${record.judgment.at} · prefer ${record.judgment.prefer.join(", ") || "none"}${record.judgment.note ? ` · ${record.judgment.note}` : ""}`] : []),
  ];
  for (const r of record.rounds) {
    out.push("", `── round ${r.n}: ${r.mode} ${"─".repeat(Math.max(0, 50 - r.mode.length))}`);
    for (const o of r.outputs) {
      out.push("", `### ${who(o.label)}${o.step ? ` (${o.step})` : ""}`);
      out.push(o.status === "ok" ? (texts.get(o.file!) ?? "").replace(/^<!--[\s\S]*?-->\n\n/, "").trim() : `[${o.status}] ${o.error}`);
    }
  }
  return out.join("\n");
}
