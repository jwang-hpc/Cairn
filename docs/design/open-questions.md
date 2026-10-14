# Open questions

1. Minimum macOS for the prototype: macOS 26 only (Apple container) vs. macOS 15 with Docker fallback.
   Default until decided: macOS 26 primary, Docker fallback implemented in launcher.
   **Decided (2026-10-14, user): macOS 26 + Apple `container` only; no Docker fallback.** M0 spike 3 shows
   Apple `container` 1.5.0 covers the needs: one bind mount, exec with output/exit code, no-network via an
   `--internal` network + `--no-dns`, and a single allowlisted domain via a host CONNECT proxy bound to that
   network's gateway. Details: spikes/containers/REPORT.md. DR-0002/DR-0005 amendments proposed in the PR.
2. Project name.
3. Facility policy for agents/commercial model services on LCRC and other DOE systems (blocks Tier 1 only).
4. University IT policy on self-hosted GitHub runners / pollers on the workstation (blocks async trigger only).
5. MCP: pi-mono now ships `@earendil-works/pi-mcp`; M0 verifies it against our executor (Streamable HTTP + bearer token).
   **M0 (2026-10-14): works** — pi-mcp 1.2.0 against a stub executor (MCP SDK 1.31.0 server) over Streamable
   HTTP, in-process and on a real loopback socket: bearer token required (missing/wrong → 401, logged), tools
   listed and called, MCP tools wrapped as pi-agent-core tools, live Claude and GPT called them correctly.
   Caveats: pi-mcp has no elicitation, so approvals are out-of-band (tool returns `pending_approval`, human
   approves in app/CLI); DR tool names with dots need a reversible mapping for providers. Details:
   spikes/pi-mcp/REPORT.md.
6. Does pi-ai subscription auth work on the Claude Team seat? (M0 spike; API fallback otherwise.)
   **M0 (2026-10-13): works** — login, calls at all four effort levels, and an agent tool loop succeed
   (claude-haiku-5-5, pi-ai 1.2.0). Caveat: pi-ai prepends a "You are Claude Code…" system prompt on this
   path; see question 10. Details: spikes/pi-auth/REPORT.md.
7. Google access path: Gemini API key vs. Vertex AI. (M0: not yet tested — no key.)
8. Microsoft MAI access path: Microsoft Foundry vs. OpenRouter / Fireworks / Baseten (availability may differ).
   (M0: not yet tested — no endpoint.)
9. Per-provider data-class permissions (which providers may receive unpublished or DOE-restricted project data).
10. (New, M0) Is pi-ai's Claude subscription mechanism acceptable under the Team seat's terms? It works by
    presenting as Claude Code (its OAuth client, `claude-cli` user-agent, Claude Code beta flags, and a
    "You are Claude Code…" system prompt). DR-0010 assumes third-party
    subscription use is permitted; confirm with the Team admin / current Anthropic terms before M1 relies on it.
    API key works as the fallback.
    **Decided (2026-10-13, user = Team owner): accepted.** Subscription OAuth stays primary for Claude per
    DR-0010; API key remains the fallback. Engineering follow-ups for M1: log the auth path on every call;
    fall back to the API key on auth/identity errors with an actionable message; health-check the OAuth
    path in `re status` so a change in Anthropic's enforcement shows up immediately.
11. (New, M0) Sign in with ChatGPT: login succeeds but every API request with the token returns HTTP 520
    from OpenAI (also via raw curl and outside the sandbox; fake tokens get a normal 401). Plan is ChatGPT
    Plus (personal; no workspace admin), and a retry ~15 min later with a valid token still returned 520, so
    neither a workspace setting nor a transient outage explains it. A fresh re-login (new token) also returns
    520. Control: the official Codex CLI (v0.162.1, "Logged in using ChatGPT", same Plus account) runs
    gpt-6.1-sol fine, so account and model are OK; only the direct-token route to api.openai.com fails.
    **Workaround (2026-10-13):** pi-ai's legacy `openai-codex` route (chatgpt.com/backend-api) works with the
    same Plus account — all effort levels and the agent tool loop pass. Caveats: pi-ai marks it superseded;
    it uses the Codex CLI's OAuth client. Still worth reporting the direct-token 520 to OpenAI/pi-ai.
    **Decided (2026-10-13): primary OpenAI path is ChatGPT Plus via pi-ai's `openai-codex` provider; the
    organization API key (`engine-mbp`, $100/month) is the automatic fallback.** M1 follow-ups: fall back on
    auth/usage-limit errors with an actionable message; health-check the route in `re status`; re-test when
    pi-ai is upgraded, since the route is marked superseded.
