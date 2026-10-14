// The context packet: identical input for every panel member (DR-0008), built from ledger files only.
import { createHash } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";

export interface Packet {
  /** Markdown given to every member. */
  text: string;
  /** Which ledger files went in. */
  sources: string[];
  sha256: string;
}

/** Cap so a large ledger can't blow up every member's context (DR-0009: context is a budget). */
export const PACKET_MAX_CHARS = 60_000;

const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}\n`;

/** PAPER.md (manifest), the hypothesis under review (if any), the exploration tree (dead ends included), decisions. */
export async function buildPacket(ledger: Ledger, opts: { hypothesis?: string; extraFiles?: string[] } = {}): Promise<Packet> {
  const parts: string[] = [];
  const sources: string[] = [];
  const add = (title: string, file: string, body: string) => {
    parts.push(section(`${title} (${file})`, body));
    sources.push(file);
  };

  add("Project manifest", "PAPER.md", await ledger.read("PAPER.md"));
  if (opts.hypothesis) {
    const h = (await ledger.hypotheses()).find((x) => x.id === opts.hypothesis);
    if (!h) throw new Error(`unknown hypothesis ${opts.hypothesis}`);
    add(
      `Hypothesis under review: ${h.id}`,
      "logic/hypotheses.md",
      [
        `**${h.id}: ${h.title}** (status: ${h.status}; provenance: ${h.provenance})`,
        `- Statement: ${h.statement}`,
        `- Prediction: ${h.prediction}`,
        `- Falsification: ${h.falsification}`,
        `- Baseline: ${h.baseline}`,
        `- Decisive experiment: ${h.decisive_experiment}`,
        `- Kill criteria: ${h.kill_criteria}`,
      ].join("\n"),
    );
  }
  add("Exploration tree (✗ = dead end; do not re-propose ruled-out ideas)", "trace/exploration_tree.yaml", "```\n" + (await ledger.renderTree()) + "\n```");
  add("Decisions so far", "engine/decisions.md", await ledger.read("engine/decisions.md"));
  for (const f of opts.extraFiles ?? []) add("Additional file", f, await ledger.read(f));

  let text = `# Context packet: ${ledger.name}\n\n${parts.join("\n")}`;
  if (text.length > PACKET_MAX_CHARS) text = `${text.slice(0, PACKET_MAX_CHARS)}\n\n[packet truncated at ${PACKET_MAX_CHARS} characters]\n`;
  return { text, sources, sha256: createHash("sha256").update(text).digest("hex") };
}
