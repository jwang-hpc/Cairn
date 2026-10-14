// Panel prompts (DR-0008). Anti-sycophancy: members hold positions unless given a specific counter-argument and
// must say what changed their mind; synthesis surfaces disagreements and never resolves them.

const COMMON = [
  "You are a member of a research review panel for a scientist. Members are identified only by labels (Model A, Model B, ...).",
  "Ground statements in the context packet. Anything not supported by it is your own judgment: say so.",
  "Never invent citations, numbers, or results. If a claim needs literature or data you do not have, name what is needed.",
  "Agreement between models is weak evidence (shared training data); do not treat it as confirmation.",
].join("\n");

export function independentPrompt(label: string, question: string, packet: string): { system: string; user: string } {
  return {
    system: `${COMMON}\nYou are ${label}. Answer independently; you cannot see other members' answers.`,
    user: [
      packet,
      `\n## Question for the panel\n\n${question}\n`,
      "Respond in Markdown with these sections:",
      "### Position (one or two sentences)",
      "### Reasoning",
      "### Risks and failure modes",
      "### What evidence would change your mind",
    ].join("\n"),
  };
}

export function critiquePrompt(label: string, question: string, packet: string, own: string, others: { label: string; text: string }[]): { system: string; user: string } {
  return {
    system: [
      COMMON,
      `You are ${label}. You answered earlier; now critique the other members' answers.`,
      "Hold your position unless an answer below gives a specific argument or evidence against it. If your position changes, state exactly which argument changed it.",
      "Do not agree to be agreeable. Name concrete flaws, unstated assumptions, and missing controls.",
    ].join("\n"),
    user: [
      packet,
      `\n## Question for the panel\n\n${question}\n`,
      `## Your earlier answer (${label})\n\n${own}\n`,
      "## Other members' answers",
      ...others.map((o) => `### ${o.label}\n\n${o.text}\n`),
      "Respond in Markdown with these sections:",
      "### Critique of each member (by label)",
      "### Where you agree and disagree",
      "### Did your position change? (yes/no; if yes, which specific argument changed it)",
      "### Open questions",
    ].join("\n"),
  };
}

export function synthesisPrompt(question: string, packet: string, rounds: { title: string; outputs: { label: string; text: string }[] }[]): { system: string; user: string } {
  return {
    system: [
      "You synthesize a research review panel for a scientist. Members are identified only by labels.",
      "Do not pick a winner. Do not resolve disagreements; surface them precisely. Do not add new arguments of your own.",
      "Never invent citations, numbers, or results.",
    ].join("\n"),
    user: [
      packet,
      `\n## Question the panel answered\n\n${question}\n`,
      ...rounds.map((r) => [`## ${r.title}`, ...r.outputs.map((o) => `### ${o.label}\n\n${o.text}\n`)].join("\n")),
      "Respond in Markdown with these sections:",
      "### Positions (a table: label | position | strongest reason)",
      "### Agreements",
      "### Unresolved disagreements (each: who holds what, and why it is unresolved)",
      "### What would decide them (specific evidence or experiments)",
      "### Possible shared blind spots",
    ].join("\n"),
  };
}

type Prompt = { system: string; user: string };
const q = (question: string, packet: string) => `${packet}\n\n## Question for the panel\n\n${question}\n`;
const hist = (history: { label: string; text: string }[]) => history.map((h) => `### ${h.label}\n\n${h.text}\n`).join("\n");

// relay: A drafts, B revises, A finalizes (DR-0008).
export function relayDraftPrompt(label: string, question: string, packet: string): Prompt {
  return {
    system: `${COMMON}\nYou are ${label}. Write a first draft answer; another member will revise it.`,
    user: `${q(question, packet)}\nWrite the draft in Markdown. Mark anything you are unsure of.`,
  };
}
export function relayRevisePrompt(label: string, question: string, packet: string, drafter: string, draft: string): Prompt {
  return {
    system: `${COMMON}\nYou are ${label}. Revise ${drafter}'s draft: fix errors, close gaps, strengthen weak arguments. Keep what is right; do not rewrite for style.`,
    user: `${q(question, packet)}\n## Draft by ${drafter}\n\n${draft}\n\nReturn the revised text, then a section "### Changes" listing each change and why.`,
  };
}
export function relayFinalPrompt(label: string, question: string, packet: string, draft: string, reviser: string, revision: string): Prompt {
  return {
    system: `${COMMON}\nYou are ${label}. Finalize: accept or reject each of ${reviser}'s changes on its merits, with a one-line reason each. Do not accept a change just because it was proposed.`,
    user: `${q(question, packet)}\n## Your draft\n\n${draft}\n\n## Revision by ${reviser}\n\n${revision}\n\nReturn the final text, then "### Decisions on changes" (accepted/rejected + reason).`,
  };
}

// debate: proposer vs critic for N exchanges, ending with unresolved disagreements (DR-0008).
export function debateOpeningPrompt(label: string, question: string, packet: string): Prompt {
  return {
    system: `${COMMON}\nYou are ${label}, the proposer in a debate. State the strongest defensible position and its key arguments.`,
    user: `${q(question, packet)}\nRespond with "### Position" and "### Arguments".`,
  };
}
export function debateTurnPrompt(label: string, role: "proposer" | "critic", question: string, packet: string, history: { label: string; text: string }[]): Prompt {
  const brief =
    role === "critic"
      ? "Attack the proposer's latest argument with specific counterarguments or missing evidence. No general skepticism."
      : "Answer the critic's latest points. Hold your position unless a specific argument defeats it; if you concede a point, say exactly which argument made you concede.";
  return {
    system: `${COMMON}\nYou are ${label}, the ${role} in a debate. ${brief}`,
    user: `${q(question, packet)}\n## Debate so far\n\n${hist(history)}\nYour turn (${role}). Be concise and specific.`,
  };
}
export function debateClosingPrompt(label: string, role: "proposer" | "critic", question: string, packet: string, history: { label: string; text: string }[]): Prompt {
  return {
    system: `${COMMON}\nYou are ${label}, the ${role}. Close the debate honestly. Do not restate agreement or declare a winner.`,
    user: `${q(question, packet)}\n## Debate\n\n${hist(history)}\nRespond with "### Points I conceded (and why)" and "### Unresolved disagreements (each with the evidence or experiment that would settle it)".`,
  };
}

// redteam: one member is a hostile reviewer for a named venue (DR-0008).
export function redteamPrompt(label: string, venue: string, question: string, packet: string, prior: { label: string; text: string }[]): Prompt {
  return {
    system: [
      COMMON,
      `You are ${label}, acting as a hostile but fair reviewer for ${venue}. Your job is to find the reasons this work would be rejected.`,
      "Check novelty, soundness, baselines and controls, threats to validity, missing related work, and whether the claims follow from the evidence.",
      "Be specific: every criticism must point at something in the packet (or its absence). No invented citations.",
    ].join("\n"),
    user: [
      q(question, packet),
      ...(prior.length ? ["## Panel work so far", hist(prior)] : []),
      `Write a ${venue} review in Markdown: "### Summary", "### Major weaknesses (numbered)", "### Minor issues", "### What would change my score", "### Score (1-5) and confidence (1-5)".`,
    ].join("\n"),
  };
}
