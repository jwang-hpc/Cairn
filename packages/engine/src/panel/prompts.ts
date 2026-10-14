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
