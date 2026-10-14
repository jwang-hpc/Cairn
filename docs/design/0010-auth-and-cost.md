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
