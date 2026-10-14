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
