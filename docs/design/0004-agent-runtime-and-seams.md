# DR-0004: Agent runtime, worker contract, and extensibility seams
Status: Accepted (2026-10-13)

## Decision
Pure pi-mono to start. The engine runs every agent loop on the host with pi-agent-core and calls models
through pi-ai. Tools are defined by us and execute inside the agent's container (DR-0005).

## Worker contract
```ts
runWorker(task: TaskSpec, worktree: WorktreeRef, role: RoleName, budget: Budget): Promise<WorkerResult>
WorkerResult = { diff: string; report: Report /* report.json */; transcriptPath: string;
                 usage: Usage[]; status: "done" | "failed" | "needs_input" }
```
`TaskSpec` is files in the worktree (task.md + referenced ARA files), not chat history.

## Seams required from day one (so a Claude Code / Codex worker can be added later as an adapter)
1. Narrow worker contract (above); no caller touches pi message/tool objects.
2. Judge by artifacts (diff, report.json, evidence/), never by transcript text.
3. Normalized event log (packages/shared/events): message, tool_call, tool_result, usage, approval.
4. Privileged capabilities as host MCP servers (packages/executor); pi tools call them via an MCP client
   (adapter if pi lacks native MCP — verify at M0).
5. Approvals live inside MCP tools, not in the agent loop.
6. Permissions as data: role policy -> container mounts + tool allowlist (later also CLI settings).
7. Skills in Agent Skills format, one folder tree, read by our loader.
8. Launcher credential slot `secrets: none | model-token` (only `none` used now).

## Future option: hybrid worker
At the experiment-implementation milestone, evaluate a Claude Code / Codex worker on golden coding tasks
(DR-0012). Keep whichever wins per task type; routing becomes configuration.
Known costs of hybrid: two event formats to normalize, model token inside container, less loop visibility.

## Model registry lag
pi-ai may not know new model IDs. Follow PiPilot's shim pattern (synthetic model entries) and keep model
IDs in config/models.yaml.

## Amendment (2026-10-14): M0 results
- **Seam 4 verified, no adapter needed.** `@earendil-works/pi-mcp` 1.2.0 talks Streamable HTTP with a
  per-session bearer token to a host MCP server; MCP tools are wrapped as pi-agent-core `AgentTool`s
  (spike 2). The token stays in the host-side client and never reaches tool args, results, or the model.
  DR tool names contain dots (`jobs.submit`); providers allow only `[A-Za-z0-9_-]`, so the engine keeps a
  reversible mapping (`mcp_jobs_submit`) and logs both names.
- **Seam 5: approvals are out-of-band.** pi-mcp implements no elicitation or sampling, so a tool cannot
  ask the user mid-call. Privileged tools return `pending_approval` plus a request id; the user approves
  in the app or CLI; the agent polls a status tool. Tools must not block waiting for a human.
- **Seam 3:** some routes (pi-ai `openai-codex`) stream over WebSocket, so usage is taken from pi-ai
  message usage, never from HTTP hooks. Implemented in M1.
- **Seam 1** is implemented by the `Engine` facade (M1.7); no pi types cross it.
