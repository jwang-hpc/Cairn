// Pure helpers for reading pi-ai payloads and responses.
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Effort-related fields of a provider payload as actually sent (DR-0013: record native settings).
 * Never copies prompts or headers.
 */
export function nativeEffort(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const pick: Record<string, unknown> = {};
  for (const k of ["thinking", "reasoning", "reasoning_effort", "output_config", "effort"]) {
    if (p[k] !== undefined) pick[k] = p[k];
  }
  // Claude 5.x "managed effort": top-level output_config is a constant; the effective per-turn effort is
  // the trailing {role:"system", output_config:{effort}} message (spike finding).
  if (Array.isArray(p.messages)) {
    const efforts = (p.messages as { role?: string; output_config?: { effort?: string } }[])
      .filter((m) => m.role === "system" && m.output_config?.effort)
      .map((m) => m.output_config!.effort);
    if (efforts.length > 0) pick.turnEffort = efforts.at(-1);
  }
  // Whether pi-ai injected the Claude Code identity on the subscription path (spike concern C1).
  if (Array.isArray(p.system)) {
    pick.claudeCodeIdentity = (p.system as { text?: string }[]).some((s) => s.text?.startsWith("You are Claude Code"));
  }
  return pick;
}

/** True if the message carries anything the agent could act on (non-empty text/thinking, or a tool call). */
export function hasContent(m: Pick<AssistantMessage, "content">): boolean {
  return m.content.some((b) =>
    b.type === "toolCall" ? true : b.type === "text" ? b.text.trim() !== "" : b.thinking.trim() !== "",
  );
}

export type FailureClass = "auth" | "limit" | "server" | "other";

/**
 * Classify a failed call. auth/limit/server failures before any content move to the next route
 * (subscription -> API key); "other" (e.g. a malformed request) would fail on every route and is surfaced.
 */
export function classifyFailure(message: string | undefined): FailureClass {
  const m = (message ?? "").toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(api[_ ]?key|token|grant)|oauth|authentication|not logged in|permission/.test(m)) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|usage.?limit|quota|too many requests|limit_exceeded|overloaded_error/.test(m)) return "limit";
  if (/\b5\d\d\b|connection|timed? ?out|econn|enotfound|socket|network|overloaded|unavailable|bad gateway/.test(m)) return "server";
  return "other";
}
