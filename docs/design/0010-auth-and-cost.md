# DR-0010: Authentication and cost governance
Status: Accepted (2026-10-13)

## Auth
- Primary: subscription logins through pi-ai (Claude Team seat, ChatGPT plan), tokens in host Keychain.
  Anthropic's help center (Oct 2026) says the Agent SDK, `claude -p`, and third-party apps can use
  subscription limits; verify behavior on the Team seat at M0 and check Team admin settings.
- Fallback: API keys (Anthropic, OpenAI) with per-machine caps.
- Personal use only. If students use the engine, each signs in with their own account.
- DOE machines hold no model credentials.

## Cost governance (three layers)
1. Provider hard caps where available: one Anthropic Console workspace and one OpenAI project per machine,
   each with its own key and spend limit.
2. Local budget governor in the engine: every model call goes through it; records machine, role, model,
   effort, tokens to engine/usage.jsonl; enforces daily quotas per machine and per role; stops a runaway loop.
3. Zero-credential machines: HPC systems never spend.

Subscription limits are per account, not per machine, so layer 2 is the only per-machine view for them.
Usage-limit errors are surfaced as actionable messages and not retried blindly (PiPilot pattern).

## Amendment (2026-10-13): multi-provider
See DR-0013. Anthropic and OpenAI may use subscription OAuth; Google and Microsoft are API-key billed.
Provider-side budgets (e.g., Google Cloud, Azure) often alert rather than hard-stop, so the local budget
governor is the enforcement point. Per-provider daily quotas are added to per-machine and per-role quotas.

## Amendment (2026-10-14): M0 and M1 results
- **Subscription routes verified (spike 1):** Claude Team seat via pi-ai `anthropic` OAuth, and ChatGPT
  Plus via pi-ai `openai-codex`. Both present themselves as the vendor's CLI (Claude: Claude Code's OAuth
  client, `claude-cli` user-agent, Claude Code beta flags, and a "You are Claude Code…" system prompt;
  OpenAI: the Codex CLI's OAuth client). The Team owner accepted this on 2026-10-13. "Sign in with
  ChatGPT" (`openai` provider, api.openai.com) returns HTTP 520 for this account and is not used.
- **API-key fallback:** one `engine-mbp` Claude workspace and one `engine-mbp` OpenAI project, with monthly
  caps set by the user (Claude $200, OpenAI $100). Layer 1 is in place for this machine.
- **Layer 2 (M1.5):** subscription calls carry only a notional list-price cost, so they are capped in
  tokens; API-key calls are capped in USD. Daily caps per provider, total, and role; per-run caps on
  turns, tokens, and billed USD.
- **Credentials:** stored in the engine home (files, 0600) until the Keychain/safeStorage store in M8.
  Logins need a loopback callback port, so they run on the host (`re login`), never in a sandbox; the
  ChatGPT and Codex flows also need a stable per-install device id.
