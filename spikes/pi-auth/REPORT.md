# M0 spike 1 — pi-ai / pi-agent-core authentication

Date: 2026-10-13 · Machine: MacBook Pro (hub) · Node 24.5.0
Packages: `@earendil-works/pi-ai@1.2.0`, `@earendil-works/pi-agent-core@1.2.0` (exact pins)
Code: `login.mjs` (interactive, run by the user), `probe.mjs` (effort sweep), `agent.mjs` (tool loop),
`lib.mjs` (file-backed `CredentialStore`, usage log). Credentials in `.secrets/` (gitignored, mode 600).

## Verdicts

| Path | Login | Calls, 4 effort levels | Agent loop + tool | Verdict |
|---|---|---|---|---|
| Anthropic — Claude Team seat OAuth | ok | ok | PASS | **works** (see concern C1) |
| Anthropic — API key | ok | ok | PASS | **works** |
| OpenAI — Sign in with ChatGPT OAuth (`openai`, api.openai.com) | ok | HTTP 520 on every model | FAIL | **blocker** (OpenAI side; see below) |
| OpenAI — ChatGPT Plus via legacy `openai-codex` (chatgpt.com/backend-api) | ok | ok | PASS | **workaround** (legacy route; see below) |
| OpenAI — API key | ok | ok | PASS | **works** |
| Google Gemini / Vertex | — | — | — | not tested (no key yet) |
| Microsoft MAI | — | — | — | not tested (no endpoint yet) |

API keys: per-machine `engine-mbp` projects on the Claude platform and the OpenAI organization (DR-0010 layer 1),
with monthly spend limits set by the user on 2026-10-13 (Claude platform: $200/month; OpenAI: $100/month). Engine-side daily and per-run caps come in M1.
Models: `claude-haiku-5-5`, `gpt-6.1-sol` (also `gpt-6-sol`, `gpt-6-luna`, `gpt-5.5` for the OAuth failure).
All IDs are in pi-ai's built-in catalog; no shim needed for Claude 5.5 or GPT 6.x.

## Effort mapping (engine level -> what pi-ai actually sends)

Engine levels map 1:1 onto pi-ai `reasoning` levels; pi-ai translates to native settings.

| Engine | Anthropic Claude 5.x ("managed effort" models) | OpenAI Responses (gpt-6.x) |
|---|---|---|
| low | `thinking.type=adaptive`; trailing system msg `output_config.effort="low"` | `reasoning.effort="low"` |
| medium | same, `effort="medium"` | `reasoning.effort="medium"` |
| high | same, `effort="high"` | `reasoning.effort="high"` |
| max | same, `effort="max"` | `reasoning.effort="max"` |

- Claude 5.x: the top-level `output_config.effort` is always `"high"`; the effective per-turn effort is a
  trailing `{role:"system", output_config:{effort}}` message. The event log must record the per-turn
  value, not the top-level field (the first version of this spike got that wrong).
- Older Claude models (≤4.5) use `thinking.budget_tokens` instead; pi-agent-core `thinkingBudgets`
  controls those. Both providers also expose `xhigh`; the engine's 4-level scale doesn't use it.
- Signal that the level is honored: output tokens at `max` vs `low` were 60 vs 4 (Haiku) and 27 vs 5
  (GPT) on the same one-word prompt.

## OpenAI ChatGPT OAuth failure (blocker for that path)

- Login succeeds; token has `aud=https://api.openai.com/v1`, scope `chatgpt.tokens.use.direct …`.
- Every request with it returns Cloudflare 520 ("origin returned an unknown error"), including a raw
  `curl GET /v1/models`, so pi-ai is not the cause.
- Same result outside the Claude Code sandbox, so the sandbox proxy is not the cause.
- Controls: a fake `sk-` key and a fake JWT both get a normal 401. Only the real ChatGPT token triggers
  the 520, so OpenAI's backend is failing on this account's token.
- Plan is ChatGPT Plus (personal; no workspace admin). Still 520 after ~15 min, and again after a fresh
  re-login with a new token, so neither a workspace setting, a transient outage, nor a bad token explains it.
- Diagnostic fetch hook: `POST https://api.openai.com/v1/responses` -> 520, `cf-ray a4a35cbc8f6b6125-ATL`,
  no `x-request-id` (the request never got an OpenAI request ID; failure is upstream of the API layer).
- Control: the official Codex CLI (v0.162.1, `codex login status` = "Logged in using ChatGPT", same Plus
  account) runs `gpt-6.1-sol` fine. Account and model are OK; only the direct-token route fails.
- **Workaround found:** pi-ai's legacy `openai-codex` provider (`chatgpt.com/backend-api`, domain approved
  2026-10-13) works with the same Plus account: gpt-6.1-sol at all four effort levels (`reasoning.effort`
  low/medium/high/max) and the agent tool loop PASS. Token valid 10 days (refresh token stored).
  Caveats: pi-ai marks this route as superseded by Sign in with ChatGPT, so it may be removed; like the Claude
  path (C1) it appears to log in with the Codex CLI's own OAuth client (`app_EMoamEEZ…`); it binds port 1455
  for login, same as the Codex CLI; it streams over a WebSocket by default, so the `fetch` hook never sees
  these calls (usage must come from pi-ai's message usage fields, per DR-0004 seam 3).
- **Decision (user, 2026-10-13):** OpenAI primary = Plus via `openai-codex`; fallback = organization API
  key (`engine-mbp` project, $100/month cap).

## Concerns for the DRs

- **C1 — The subscription path presents itself as Claude Code at every layer.** From pi-ai 1.2.0 source:
  login uses a hard-coded OAuth client ID (stored base64-encoded) with scopes including
  `user:sessions:claude_code`; each request with the token sends `user-agent: claude-cli/<version>`,
  `x-app: cli`, beta flags `claude-code-20250219` + `oauth-2025-04-20`, and prepends the system prompt
  "You are Claude Code, Anthropic's official CLI for Claude." (visible as +24 input tokens: 44 vs 20).
  So the Team seat is reached as if it were Claude Code, not as a disclosed third-party app. DR-0010
  assumes third-party subscription use is permitted; whether this mechanism is acceptable under the Team
  seat's terms is a decision for the user/Team admin before M1 relies on it.
- **C2 — Node ignores proxy env by default.** Node's `fetch` does not honor `HTTPS_PROXY`; in the sandbox
  every call failed with "Connection error" until `NODE_USE_ENV_PROXY=1` (Node ≥24). Relevant to M2:
  anything Node-based behind an egress proxy needs this flag (or an explicit agent).
- **C3 — Logins need a loopback port.** Both OAuth flows start a callback server (Anthropic 53692 with
  fallback; ChatGPT 1455, hard failure if it can't bind). Login must run on the host engine, outside any
  confined sandbox — consistent with DR-0005.
- **C4 — ChatGPT login needs a stable per-installation UUID** (`LoginOptions.getDeviceId`, sent as
  `ext_agent_host_id`). The engine must create one per machine once and keep it with the credentials.
- **C5 — Credential storage is app-owned.** pi-ai takes an injected `CredentialStore` (serialized
  `modify`, refresh under lock). A Keychain-backed store for M8 needs no pi-ai changes.
- **C6 — `pi-telemetry` is an unpinned transitive dep** (`^1.2.0`). It is an in-process span API with no
  network code; lock it via the lockfile/overrides in M1.
- **C7 — `usage.cost` is computed for subscription calls too** (API list price). For OAuth calls it is
  notional; the budget governor should label it as such rather than treat it as spend.

## Not verified
- Token refresh (access tokens were fresh; no refresh occurred). Anthropic token expires ~10 h after login.
- Subscription usage-limit errors and their messages.
- Opus/Sonnet-class models (only Haiku 5.5 tested on Anthropic, to spare subscription limits).
- Gemini, Vertex, MAI.
