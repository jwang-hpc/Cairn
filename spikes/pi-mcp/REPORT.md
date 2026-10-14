# M0 spike 2 — pi-mcp ↔ stub executor (Streamable HTTP, bearer token)

Date: 2026-10-14 · Node 24.5.0
Packages: `@earendil-works/pi-mcp@1.2.0` (client; only dependency `cross-spawn`, no MCP SDK),
`@modelcontextprotocol/sdk@1.31.0` (stub server only), `@earendil-works/pi-agent-core@1.2.0`, `pi-ai@1.2.0`.
Code: `executor-stub.mjs` (stub executor: auth + Host guard in front of an MCP server with `jobs.submit` /
`jobs.status`), `spike.mjs` (checks). Modes: in-process (injected `fetch`), `--socket` (loopback), `--live`.

## Verdict: works

| Check | In-process | Socket | Notes |
|---|---|---|---|
| No token → 401 | PASS | PASS | pi-mcp raises `McpAuthRequiredError` (status 401) |
| Wrong token → 401 | PASS | PASS | constant-time compare; token never logged |
| Foreign `Host` → 403 | PASS | n/a | DNS-rebinding guard in our handler (SDK's built-in guard is deprecated) |
| `initialize` with token | PASS | PASS | protocol `2025-11-25` negotiated |
| `tools/list` | PASS | PASS | `jobs.submit`, `jobs.status` |
| Lint rejects a path for a name | PASS | PASS | `../../etc/passwd` → `isError` result |
| Approval inside the tool | PASS | PASS | `jobs.submit` → `pending_approval` + request id; never auto-approved |
| Out-of-band approval → status | PASS | PASS | approval happens outside MCP (app/CLI), tool reflects it |
| pi-agent-core agent → MCP tool (scripted model) | PASS | PASS | wrapper from pi-mcp README |
| Live Claude Haiku 5.5 (Team OAuth) calls the tool | PASS | — | correct args, reported request id |
| Live GPT-6.1-sol (Plus, `openai-codex`) calls the tool | PASS | — | correct args, reported request id |
| Session close (DELETE) | PASS | PASS | server sees `session_close` |

In-process mode runs the real Streamable HTTP protocol (sessions, SSE streams, headers) through the
SDK's `WebStandardStreamableHTTPServerTransport.handleRequest(Request)`, with pi-mcp's injectable
`fetch` — everything except the TCP socket. The socket column was run by the user outside the Claude
Code sandbox (which blocks local port binding, `EPERM`) on 2026-10-14: `node spike.mjs --socket`, all 9
socket checks passed on `127.0.0.1:<ephemeral>`. The Host check is in-process only (a real socket
can't spoof the Host header without a second hostname).

## Findings

- **F1 — Seam 4 works as designed, no adapter needed.** pi-mcp's `StreamableHttpTransport({ url, headers })`
  carries the bearer token; `toLlmContent()` + a ~10-line wrapper turns MCP tools into `AgentTool`s.
  The token lives only in the host-side client transport — never in tool args, results, or the model's
  context (verified: absent from the server audit).
- **F2 — No elicitation in pi-mcp.** It handles only `ping` and `roots/list` server requests (no
  elicitation, sampling, or tasks). So approvals can't be "ask the user via MCP"; they must be
  out-of-band: the tool returns `pending_approval` + id, the human approves in the app/CLI, the agent
  polls `jobs.status`. This matches DR-0006 (approval card in the app) and seam 5 (approval inside the
  tool, not the agent loop). The engine should not wait synchronously inside a tool call.
- **F3 — Tool names.** DR-0006 names (`jobs.submit`) contain dots; providers allow only
  `[A-Za-z0-9_-]{1,64}`, so the wrapper maps them (`mcp_jobs_submit`). Keep a reversible mapping in the
  engine and log both names.
- **F4 — Host/Origin checks belong in our handler.** The SDK's `allowedHosts`/DNS-rebinding options are
  deprecated in favor of external middleware. The executor's HTTP front should check `Host`, bearer
  token, and path before anything reaches MCP, and log every rejection (DR-0005 escape tests).
- **F5 — The stub can stay socketless for tests.** `handle(Request) → Response` + injected `fetch` makes
  executor tests hermetic (no ports), which also keeps them runnable inside sandboxes and CI.
- **F6 — Real providers accept these schemas** (`enum`, `additionalProperties: false`, `required`) on both
  subscription routes.

## For M2/M5
- `packages/executor`: one MCP server per capability family behind a shared auth/Host front; per-session
  random token (32 bytes) issued by the engine; bind `127.0.0.1` only.
- The agent loop runs on the host (DR-0005), so the MCP client and token never enter a container. If a
  container-side tool ever needs the executor, route it through the host (not by mounting the token).
- Escape test seeds: no token, wrong token, foreign Host, path-for-name, unknown target — all already
  exercised here.

## Not verified
- Server-to-client GET stream reconnection / `Last-Event-ID` resumption under a dropped connection.
- Progress notifications and cancellation of a long-running tool call.
