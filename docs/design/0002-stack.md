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

## Amendment (2026-10-14): M0 results
- **Isolation: Apple `container` only.** Verified with Apple `container` 1.5.0 on macOS 26.6.2 (spike 3).
  The Docker fallback is dropped by user decision (open question 1), so agents run only on macOS 26 hosts.
  Campaigns on the Linux workstation are deterministic code (DR-0011) and need no agent containers.
- **Agent runtime confirmed:** `@earendil-works/pi-ai`, `pi-agent-core`, and `pi-mcp` at 1.2.0 (spikes 1, 2).
- **Toolchain:** pnpm 10.34.6 (pnpm 12 can't be launched by Node 24.5's bundled corepack and downloads a
  native binary at runtime), TypeScript 7.0.2, vitest 5.0.2, all pinned exactly.

## Amendment (2026-10-14): engine API is HTTP + SSE
User decision (M8.1): the engine's local API is plain HTTP plus Server-Sent Events, not WebSocket, built on Node
built-ins with no new dependency. Actions (approve, deny, judge, check, review) and reads are HTTP requests with JSON
in and out; the only server-to-app traffic the app needs, new engine events and job state changes, is one SSE
stream (`GET /api/events`). The "HTTP/WebSocket" in the table above now means HTTP + SSE.
- **Serving:** `re serve [--port N]` binds `127.0.0.1` only (default: any free port; DR-0005 amendment: engine
  services bind loopback). It writes `<home>/api.json`, mode 0600, `{ url, token, pid }`, which the app reads to
  find the engine; the file is removed on exit, and a second engine refuses to start while the first is alive.
- **Access:** a bearer token of 32 random bytes, new every start, compared in constant time; Host must be
  `127.0.0.1` or `localhost` with the bound port (DNS rebinding); a request with an `Origin` header other than
  `null` or a configured app origin is refused, so a web page in the user's browser can't drive approvals. Every
  refusal and every state-changing request is appended to `<home>/audit.log` as actor `api`. The token is never
  logged, printed, or returned.
- **Thin client holds both ways:** every endpoint wraps the same engine functions the CLI calls
  (`packages/engine/src/api/`), so whatever the app does, `re` can do, and the ledger records are the same.
- **Events:** the stream tails `events.jsonl` by offset (1 s polling, no `fs.watch`), compares job states from the
  job store (2 s), and sends a heartbeat comment every 15 s. A browser `EventSource` can't send an
  `Authorization` header, so the app reads the stream with `fetch` (renderer or Electron main process).
