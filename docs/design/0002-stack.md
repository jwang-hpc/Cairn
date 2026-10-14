# DR-0002: Technology stack
Status: Accepted (2026-10-13)

| Layer | Choice |
|---|---|
| App shell | Electron + React + TypeScript (follows PiPilot) |
| Engine | TypeScript (Node LTS), headless; exposes a local HTTP/WebSocket API and a CLI |
| Agent runtime | pi-mono (MIT): `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-mcp` (MCP client: stdio + Streamable HTTP). Pin exact versions; main was 1.2.0 on 2026-10-13. |
| Isolation | Apple `container` CLI (1.0, per-container micro-VM; best on macOS 26); Docker fallback in launcher |
| Secrets | Electron `safeStorage` / macOS Keychain, host only |
| Parsers/analysis | Python scripts invoked as tools inside containers |
| Ledger | ARA artifact in git (DR-0007); RKA possibly later as a retrieval layer |
| Packaging | Signed + notarized with Developer ID, distributed outside the Mac App Store (App Sandbox would block VMs/SSH/CLIs) |

Rule: the app is a thin client. Anything possible in the app must be possible via the engine CLI.
The same engine runs headless on the workstation for campaigns.

Alternatives considered: SwiftUI shell + Python engine (rejected: lose PiPilot reuse, two languages);
vendor CLIs as runtime (deferred: possible later as a second worker, DR-0004).

## Amendment (2026-10-13): pi-mono package rename
pi-mono packages moved from `@mariozechner/*` (0.70.x, used by PiPilot) to `@earendil-works/*` (1.x).
Code borrowed from PiPilot must be ported to the new package names/APIs. pi-mono now ships `pi-mcp`
(standalone MCP client), which implements seam 4 of DR-0004 without a custom adapter. `pi-durable`
(experimental, crash-resumable harness) and `pi-evals` are worth evaluating for DR-0011 and DR-0012.
