# DR-0013: Multi-provider model layer
Status: Accepted (2026-10-13)

## Scope
Frontier models from Anthropic (Claude), OpenAI (GPT), Google (Gemini), and Microsoft (MAI) are
first-class. Others can be added through pi-ai without design changes.

## Access matrix (verify each at M0)
| Vendor | pi-ai provider | Auth |
|---|---|---|
| Anthropic | `anthropic` | OAuth (Claude subscription) or API key |
| OpenAI | `openai` (Sign in with ChatGPT) | OAuth or API key |
| Google | `google` (Gemini API) or `vertex` (Gemini via Vertex AI) | API key / Google Cloud credentials |
| Microsoft MAI | OpenAI-compatible endpoint: Microsoft Foundry deployment, or OpenRouter / Fireworks / Baseten | API key |
| OpenAI via Azure (optional) | `azure-openai-responses` | Azure key |

pi-ai (1.2.0, 2026-10-13) lists OAuth only for Anthropic, OpenAI, OpenAI Codex (legacy), GitHub Copilot,
and OpenRouter. Google and Microsoft are therefore API-key billed: the budget governor (DR-0010) is the
primary spend control for them. MAI availability varies by source and region (some reports: private
preview in Foundry; others: also on third-party hosts). MAI models expose an OpenAI-compatible Chat
Completions API, so a custom/OpenAI-compatible provider works if no built-in path fits.

## Model registry (config/models.yaml)
Each model entry: provider, native id, context window, modalities, tool-use grade (measured by evals, not
assumed), effort mapping, cost tier, allowed data classes, date terms were last checked.

## Effort normalization
Engine levels: low | medium | high | max. Each provider maps them to its native control (thinking
enabled + budget tokens, reasoning effort, etc.) in config. The event log records both normalized and
native settings.

## Data governance (new invariant)
Each project declares a data class: `public`, `unpublished`, or `restricted` (e.g., DOE project data with
handling requirements). Each provider declares which classes it may receive, based on the user's review of
that provider's terms (retention, training on inputs, enterprise agreements). The engine refuses to send any
packet from a project to a provider not allowed for its class, and logs the refusal.

## Panel composition (amends DR-0008)
- Default: members from different vendors (diversity is the point of a panel).
- Default size 2–3, configurable max; cost scales linearly with members and rounds.
- Synthesis is done by a model outside the panel, or rotates; vendor of every member is recorded.

## Role eligibility
Tool-using roles (coder, analysis, literature) only use models that pass the tool-use evals. Panel-only
(tool-less) roles may use any model allowed for the project's data class.

## Routing, fallback, and lag
- Defaults per role are chosen by the eval suite across all providers (DR-0012); re-run when a model or
  provider is added.
- Per-role fallback chain for outages or usage limits.
- Registry lag: PiPilot-style shim entries or pi-ai dynamic/custom providers; model IDs only in config.
- Prompt caching behavior differs per provider; keep stable prefixes and measure cost per provider.

## Amendment (2026-10-14): M0 and M1 results
- **Access matrix, OpenAI row:** subscription via pi-ai `openai-codex` (ChatGPT Plus,
  `chatgpt.com/backend-api`); API key via `openai`. "Sign in with ChatGPT" via `openai` returns HTTP 520
  (spike 1) and is not used. Google and Microsoft are still untested (no keys yet).
- **Routes in config:** `models.yaml` providers list ordered routes (subscription first, API key after);
  the model layer falls back only on auth, limit, or server errors that arrive before any content (M1.6).
- **Effort mapping verified** for engine levels low–max: Anthropic Claude 5.x via a per-turn
  `output_config.effort` system message (the top-level field is a constant); OpenAI via
  `reasoning.effort` on both routes. Recorded in `config/models.example.yaml`.
- **Data governance** is enforced in the model layer (M1.6): a refused data class sends nothing and is
  logged as a policy-denied `approval` event.
- **Declared at creation, never defaulted (2026-10-14):** `re project new` takes `--data-class`, or asks for it in a
  terminal; without one it creates nothing. Most projects hold open science data (`public`), but only the user can
  say so. `projects_default_data_class` applies only to calls outside any project (`re ask`, a run on a plain repo).
