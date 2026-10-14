# M0 spike 4 — executor over user-held SSH ControlMasters

Date: 2026-10-14 · run by the user on the MacBook over the university VPN (the Claude Code sandbox
can't read `~/.ssh`, by design). Code: `open-master.sh` / `close-master.sh` (user opens/closes the
session), `spike.mjs` (Node driver; built-ins only).

## Design under test (DR-0006)
- The **user** opens one ControlMaster per host (`open-master.sh`): key for the workstation (via
  a `ProxyJump` jump host), password + Duo push for UNCC HPC. That interactive step is the human gate.
  Sockets live in `.engine/ssh/%C` (0700, gitignored), `ControlPersist=4h`.
- The **executor** connects **mux-only**: `ControlMaster=no`, `BatchMode=yes`, and every auth method off
  (`PubkeyAuthentication`, `PasswordAuthentication`, `KbdInteractiveAuthentication`, `GSSAPI…`,
  `Hostbased…`, `IdentityAgent=none`), plus `ForwardAgent=no`, `ForwardX11=no`,
  `ClearAllForwardings=yes`. Command-line `-o` overrides `~/.ssh/config`. Remote scripts go to `sh -s`
  on stdin (no shell quoting of untrusted strings).

## Verdict: works

| Check | Result | Detail |
|---|---|---|
| Workstation master live | PASS | key auth through the jump host; university banner shown once at open |
| Workstation resource probe (no scheduler) | PASS | Linux 7.0, 12 CPUs, 62 GB RAM, 1× NVIDIA RTX 6000 Ada (48 GB), `$HOME` 35 GB free |
| Command latency over the master | PASS | ~60 ms per command through the jump host (one 156 ms outlier) |
| HPC master live (password + Duo) | PASS | one Duo push per master |
| Slurm discovery (read-only) | PASS | Slurm 24.11.5 on a login node; 5 partitions: Orion (default), GPU, DTN (30-day limits), Nebula, Nebula_GPU (2-day); 1 account association |
| `sbatch --test-only`, small job | PASS | parsed: would start on `str-c60`, 1 proc, partition Orion; nothing submitted |
| `sbatch --test-only`, oversized job rejected | PASS* | Slurm refused (exit 1): `allocation failure: More processors requested than permitted` |
| Workstation unreachable after closing its master | PASS | `Permission denied (publickey,password)` — the user's key is **not** usable by the executor |
| HPC unreachable after closing its master | PASS | `Permission denied (…)` |

\*The run reported FAIL for this check: Slurm 24.11 prints `--test-only` rejections as
`allocation failure: <reason>`, which the first parser (expecting `error:`) missed. The rejection itself
was correct. The parser now accepts both formats; it was validated against the recorded output and the
classic `sbatch: error: Batch job submission failed: …` form, **not** re-run live (that needs another
Duo login).

## Findings for M5 (executor)
- **F1 — Session scope holds for both hosts.** Closing the master revokes the executor's reach even on
  the key-based workstation, because the executor disables all auth methods for its own connections.
  The user's key and agent remain theirs alone.
- **F2 — `--test-only` gives a free pre-flight.** It validates partition/account/limits and estimates a
  start time without queueing. Use it in `jobs.submit` linting before the approval card, and show the
  estimate on the card.
- **F3 — Parse Slurm defensively.** Message formats differ by version/path (`sbatch: error: …` vs
  `allocation failure: …`); keep parsers tolerant and keep raw output in the audit log.
- **F4 — The workstation has no scheduler.** `jobs.submit` there needs a runner (e.g. `systemd-run
  --user` or a detached `tmux`/`nohup` wrapper with a PID file) and its own resource checks. `$HOME` has
  only 35 GB free: experiment data must go to a configured scratch path, not `$HOME`.
- **F5 — Duo cadence.** One push per master; `ControlPersist=4h` bounds how long the executor can act
  without the user. Campaign runs longer than that belong on the workstation or in scheduler arrays
  (DR-0011), not on a live master.
- **F6 — Global `ForwardAgent yes` was in the user's `~/.ssh/config`.** The executor forces it off; the
  user has since moved it to `Host * ForwardAgent no` and added a key passphrase.
- **F7 — Hostnames stay out of git.** The spike uses `~/.ssh/config` aliases (`workstation`,
  `hpc-uncc`); `config/machines.yaml` (gitignored) should hold aliases, not raw hostnames.

## Not verified
- Live re-run after the parser fix (see above).
- Real submission, `squeue`/`sacct` status, cancel, and `fetch_results` (M5).
- Master expiry mid-command and reconnect behavior; VPN drop.
- DOE machines (Tier 0) — not touched.
