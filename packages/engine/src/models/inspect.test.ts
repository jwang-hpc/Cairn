import { describe, expect, it } from "vitest";
import { classifyFailure, hasContent, nativeEffort } from "./inspect.js";

describe("nativeEffort", () => {
  it("reads the per-turn effort of Claude 5.x managed-effort payloads (spike shape)", () => {
    const payload = {
      model: "claude-haiku-5-5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [
        { role: "user", content: "secret prompt" },
        { role: "system", content: [], output_config: { effort: "low" } },
      ],
    };
    const n = nativeEffort(payload);
    expect(n).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      turnEffort: "low",
      claudeCodeIdentity: true,
    });
    expect(JSON.stringify(n)).not.toContain("secret prompt");
  });

  it("reads OpenAI Responses reasoning effort", () => {
    expect(nativeEffort({ model: "gpt-6.1-sol", reasoning: { effort: "max", summary: "auto" }, input: [] })).toEqual({
      reasoning: { effort: "max", summary: "auto" },
    });
  });

  it("tolerates missing payloads", () => {
    expect(nativeEffort(undefined)).toEqual({});
  });
});

describe("classifyFailure", () => {
  it.each([
    ['OpenAI API error (520): 520 {"title":"Error 520: Web server is returning an unknown error"}', "server"],
    ["Connection error.", "server"],
    ["429 usage limit reached", "limit"],
    ["subscription_sharing_usage_limit_exceeded", "limit"],
    ["401 invalid api key", "auth"],
    ["OAuth token refresh failed: invalid_grant", "auth"],
    ["400 invalid request: unknown parameter 'foo'", "other"],
    [undefined, "other"],
  ] as const)("%s -> %s", (message, expected) => {
    expect(classifyFailure(message)).toBe(expected);
  });
});

describe("hasContent", () => {
  it("ignores empty text and counts tool calls", () => {
    expect(hasContent({ content: [{ type: "text", text: "  " }] })).toBe(false);
    expect(hasContent({ content: [{ type: "text", text: "ok" }] })).toBe(true);
    expect(hasContent({ content: [{ type: "toolCall", id: "t", name: "add", arguments: {} }] })).toBe(true);
  });
});
