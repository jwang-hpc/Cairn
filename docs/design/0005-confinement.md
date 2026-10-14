# DR-0005: Agent confinement and security model
Status: Accepted (2026-10-13)

## Threats
(1) reading secrets outside the worktree; (2) writing outside it / persistence; (3) network exfiltration;
(4) prompt injection via papers, web pages, or third-party skills; (5) reaching remote machines.

## Architecture: loop on host, tools in container
- The pi agent loop and all credentials run in the host engine.
- Each agent gets its own container (Apple `container`, Docker fallback) and its own git worktree.
- Every tool call (bash, file read/write, python) executes via `container exec` in that container.
- Mounts: worktree (rw), skills/ (ro), outbox/ (rw, for requests and artifacts). Nothing else.
- Egress deny-by-default; per-role allowlist. The engine host port for MCP is reachable only with a
  per-session bearer token.
- No GitHub write token, SSH key, or model token inside containers. Pushes happen from the host after review.

## Roles (config/roles.yaml)
| Role | Read | Write | Network | Executor tools |
|---|---|---|---|---|
| literature | lit/, logic/ | lit/ | literature API proxy only | literature.* |
| coder | src/, logic/experiments.md | src/, experiments/ | package registries | jobs.submit (approval) |
| analysis | evidence/, logic/ | analysis/, draft claims | none | jobs.fetch_results |
| panel | context packet only | own response file | none | none |
| writer | logic/, evidence/, drafts/ | drafts/ | none | none |
Read restrictions are enforced by mounting subsets of the worktree (or separate sparse worktrees).

## Content hygiene
Fetched content is untrusted. The literature role cannot write code or experiments. Third-party skills are
vendored and pinned, never installed live.

## Escape tests (tests/escape/, from M2; must always pass)
Agent attempts: read ~/.ssh and ~/.claude; write outside worktree; reach a non-allowlisted domain; call an
executor tool without a valid token; submit a job violating machine policy. Every attempt must fail and be logged.

## Amendment (2026-10-14): M0 results (spike 3)
- **Runtime:** Apple `container` only (DR-0002 amendment); "Docker fallback" above no longer applies.
- **Verified egress mechanism:**
  1. One `--internal` (host-only) network per agent; container started with `--no-dns`. Result: no
     internet, no DNS (closes DNS exfiltration), host services bound to `127.0.0.1` unreachable.
  2. Role allowlists (`roles.yaml` `network:`) enforced by an engine-owned CONNECT proxy bound **only** to
     that network's gateway IP; the container gets `HTTPS_PROXY` explicitly; the proxy resolves names on
     the host; every allow/deny is logged. Roles with `network: []` get no proxy.
- **Hardening baseline:** `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, non-root `--user`, bind mounts
  only for the paths this DR lists. Exec returns stdout, stderr, and exit code.
- **The launcher must never emit:** `--ssh` (forwards the SSH agent), `--publish-socket`, bare `-e KEY` or
  `--env-file` (inherit host env), `--virtualization`, `--cap-add`.
- **Engine services bind `127.0.0.1`.** Anything listening on `0.0.0.0` is presumably reachable from the
  internal network via the gateway.
- **Escape tests to add in M2:** host-port probe from an agent container; container-to-container on the
  same network; `--network none` (accepted by the CLI, isolation unverified — don't rely on it).
