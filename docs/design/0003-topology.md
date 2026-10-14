# DR-0003: Deployment topology and sync
Status: Accepted (2026-10-13)

- MacBook Pro = hub. Holds the engine, ledger working copies, credentials, executor, and the app.
- Workstation (behind university VPN) = long-running jobs, campaigns, local GPU work. Runs the engine headless.
- UNCC HPC and DOE lab HPCs (e.g., LCRC Bebop) = batch execution targets only (DR-0006).
- GitHub private repo = rendezvous for code and ledger. All machines connect outbound only.

Operation: reconcile on wake. Submitting work records job IDs in the ledger and returns; a `status`
command reconciles all outstanding jobs when the user is back. Long sweeps are expressed in the scheduler
(job arrays + `afterok` dependencies) or run on the workstation, so nothing depends on the laptop staying awake.

Interactive access to the workstation: VPN + SSH (VPN client scripted by the hub).
Asynchronous trigger (later milestone): a poller on the workstation (git fetch loop executing approved task
files) or a self-hosted GitHub Actions runner restricted to a path/branch; check university IT policy first.
