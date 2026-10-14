# M0 spike 3 — Node drives Apple `container`

Date: 2026-10-14 · macOS 26.6.2 (arm64) · Apple `container` 1.5.0 (kata kernel 3.32.0) · Node 24.5.0
Image: `docker.io/curlimages/curl:8.11.1` (pinned tag). Code: `spike.mjs` (Node built-ins only; calls the
`container` CLI with argument arrays, never a shell). Run by the user outside the Claude Code sandbox
(which can't reach `container-apiserver`). Docker was **not** tested: dropped by user decision (see below).

## Verdict: works

| Check | Result | Detail |
|---|---|---|
| Pull pinned image | PASS | 8.4 s, one-time |
| `network create --internal` | PASS | mode `hostOnly`, own subnet (192.168.128.0/24), gateway on the Mac |
| Hardened container with **one** bind mount | PASS | `--read-only --tmpfs /tmp --cap-drop ALL --user 1000:1000 --network <internal> --no-dns --mount type=bind,…,target=/work` |
| `exec` captures stdout, stderr, exit code | PASS | `exit 7` propagates as exit code 7 |
| Writes land only in the mount | PASS | uid 1000 can write `/work` (virtiofs); root fs read-only |
| No host paths inside (invariant 2) | PASS | only `virtiofs on /work`; no `/Users`, no home mount |
| No host env inside | PASS | env keys: `CURL_CA_BUNDLE HOME PATH PWD SHLVL` |
| No network: internal + `--no-dns` | PASS | name lookup times out; direct IP (1.1.1.1) times out |
| Host services on `127.0.0.1` unreachable | PASS | connection refused via the gateway IP |
| Allowlisted domain via host CONNECT proxy | PASS | proxy bound **only** to the internal gateway; `pypi.org` → HTTP 200 |
| Non-allowlisted domain refused + logged | PASS | `example.com` → proxy 403, logged as deny |
| Bypassing the proxy | PASS | `--noproxy '*'` fails: no DNS, no route |
| Control: default NAT network has internet | PASS | `example.com` → 200 (so the denials are real) |
| Cleanup | PASS | no leftover containers/network |
| `--network none` | accepted, **unverified** | flag not in `--help`; a container started with it, but isolation was not tested — don't rely on it |

**Start times:** first container 6.7 s (cold VM/kernel), later ones 0.7–1.3 s. One VM per agent is affordable.

## Egress design that works (for M2's launcher)
1. One `--internal` (host-only) network; container started with `--no-dns` → no internet, no DNS
   (closes DNS exfiltration), host loopback services unreachable.
2. Host-side CONNECT proxy owned by the engine, bound **only** to that network's gateway IP; allowlist
   from the role policy (`config/roles.yaml` `network:`); every decision logged (DR-0005 escape tests).
3. Container gets `HTTPS_PROXY` explicitly; the proxy resolves names on the host, so the container
   needs no resolver.
4. Roles with `network: []` get the internal network and no proxy at all.

## Findings / risks for M2
- **F1 — Dangerous flags exist and must be impossible to emit:** `--ssh` (forwards the SSH agent
  socket — invariant 1/4), `--publish-socket`, bare `-e KEY` / `--env-file` (inherit host env),
  `--virtualization`, `--cap-add`. The launcher should build argv from policy and reject these.
- **F2 — Anything on the Mac listening on all interfaces (`0.0.0.0`) is presumably reachable** from the
  internal network via the gateway IP (only `127.0.0.1` was tested). Mitigations: bind engine services
  to `127.0.0.1` or the specific gateway; consider a pf rule for the internal subnet; add an escape test
  that probes common host ports.
- **F3 — Containers on the same internal network can likely reach each other** (not tested). For
  per-agent isolation use one internal network per agent (cheap: networks are created in < 1 s) and a
  per-network proxy listener with that role's allowlist.
- **F4 — The default kernel is a `-debug` build** (`vmlinux-6.18.35-197-debug`, kata 3.32.0). Fine for
  the prototype; revisit for production.
- **F5 — `container` needs the user's session** (`container system start`, apiserver over XPC). The
  engine runs on the host as the user, so this is fine; it can't be driven from inside a sandbox.
- **F6 — Image supply chain:** pin by digest, not tag, in M2; build our own `containers/agent/` image
  and host it on the user's GHCR (`ghcr.io/jwang-hpc/…`) so agents don't depend on Docker Hub at runtime.

## Decision recorded: Docker fallback dropped
The user decided (2026-10-14) that a Docker fallback is not needed; macOS 26 + Apple `container` is the
only runtime. Consequence: agents run only on macOS 26 hosts (the MacBook). Campaigns on the Linux
workstation are deterministic code (DR-0011) and don't need agent containers. Proposed amendments to
DR-0002 (Isolation row) and DR-0005 ("Docker fallback") are in the PR description.

## Not verified
- `--network none` isolation; container-to-container reachability on one internal network; host
  services bound to `0.0.0.0` / the gateway.
- Read-only sub-mounts (e.g. `skills/` ro) and multiple mounts per container (DR-0005 needs worktree rw,
  skills ro, outbox rw) — one rw mount tested.
- Resource limits (`--cpus`, `--memory`) and behavior under load.
