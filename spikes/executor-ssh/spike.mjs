// M0 spike 4 (throwaway): executor reaches remote machines ONLY through user-opened SSH ControlMasters
// (DR-0006). Every call is mux-only: BatchMode on, all authentication methods off, forwarding off, so
// without a live master nothing connects and nothing ever prompts.
//   sh open-master.sh workstation && sh open-master.sh hpc-uncc   # you: key / password + Duo
//   node spike.mjs [--workstation workstation] [--hpc hpc-uncc] [--keep]
// --keep leaves the masters open (skips the revocation check).
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: { workstation: { type: "string", default: "workstation" }, hpc: { type: "string", default: "hpc-uncc" }, keep: { type: "boolean" } },
});
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CTL = join(REPO, ".engine", "ssh", "%C");

// Mux-only: use the master's channel or fail. Command-line -o wins over ~/.ssh/config.
const MUX_ONLY = [
  "ControlMaster=no", `ControlPath=${CTL}`, "BatchMode=yes", "ConnectTimeout=10",
  "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes",
  "PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
  "GSSAPIAuthentication=no", "HostbasedAuthentication=no", "IdentityAgent=none",
].flatMap((o) => ["-o", o]);

function sh(args, { input, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 });
    });
    p.stdin.end(input ?? "");
  });
}
/** Run a POSIX sh script on the host through the master (script on stdin, no quoting games). */
const remote = (host, script, o) => sh([...MUX_ONLY, host, "sh", "-s"], { input: script, ...o });
const masterAlive = async (host) => (await sh(["-o", `ControlPath=${CTL}`, "-O", "check", host])).code === 0;

const results = [];
const raw = {};
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: String((await fn()) ?? "") });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
const must = (c, m) => {
  if (!c) throw new Error(m);
};
const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

// ---------------- workstation ----------------
const W = opt.workstation;
await check(`${W}: user-opened master is live`, async () => {
  must(await masterAlive(W), `no master — run: sh open-master.sh ${W}`);
  return "ok";
});
await check(`${W}: resource probe over the master (no scheduler)`, async () => {
  const r = await remote(W, [
    'echo "HOST=$(hostname)"', 'echo "OS=$(uname -sr)"', 'echo "CPUS=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"',
    "awk '/MemTotal/{print \"MEM_GB=\" int($2/1048576)}' /proc/meminfo 2>/dev/null",
    'echo "LOAD=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/GPU=/'",
    "df -Pk \"$HOME\" | awk 'NR==2{print \"HOME_FREE_GB=\" int($4/1048576)}'",
  ].join("\n"));
  raw.workstation = r;
  must(r.code === 0, `exit ${r.code}: ${r.err}`);
  const f = kv(r.out);
  must(f.HOST && f.CPUS, `unparsed: ${r.out}`);
  return `${f.HOST} · ${f.OS} · ${f.CPUS} CPUs · ${f.MEM_GB ?? "?"} GB · load ${f.LOAD} · GPU ${f.GPU ?? "none"} · $HOME free ${f.HOME_FREE_GB} GB · ${r.ms} ms`;
});
await check(`${W}: per-command latency over the master`, async () => {
  const times = [];
  for (let i = 0; i < 5; i++) times.push((await remote(W, "true")).ms);
  return `${times.join(", ")} ms`;
});

// ---------------- UNCC HPC (Slurm) ----------------
const H = opt.hpc;
let partition;
let account;
await check(`${H}: user-opened master is live (password + Duo)`, async () => {
  must(await masterAlive(H), `no master — run: sh open-master.sh ${H}`);
  return "ok";
});
await check(`${H}: discover Slurm partitions and accounts (read-only)`, async () => {
  const r = await remote(H, [
    'echo "HOST=$(hostname)"',
    'echo "SLURM=$(sbatch --version 2>/dev/null)"',
    "echo '--- sinfo'", "sinfo -h -o '%P|%a|%l|%D' 2>&1 | head -40",
    "echo '--- assoc'", 'sacctmgr -nP show assoc user="$USER" format=account,partition,qos 2>&1 | head -40',
    "echo '--- default'", 'sacctmgr -nP show user "$USER" format=defaultaccount 2>&1 | head -2',
  ].join("\n"));
  raw.hpcDiscover = r;
  must(r.code === 0, `exit ${r.code}: ${r.err}`);
  const [, sinfo = "", rest = ""] = r.out.split(/^--- sinfo$/m).join("\u0000").split(/\u0000|^--- assoc$/m);
  const parts = sinfo.trim().split("\n").filter((l) => l.includes("|")).map((l) => {
    const [p, avail, limit, nodes] = l.split("|");
    return { name: p.replace(/\*$/, ""), isDefault: p.endsWith("*"), avail, limit, nodes: Number(nodes) };
  });
  must(parts.length > 0, `no partitions parsed:\n${r.out}`);
  partition = (parts.find((p) => p.isDefault) ?? parts[0]).name;
  const defaultAcct = r.out.split(/^--- default$/m)[1]?.trim().split("\n")[0]?.trim();
  const assocAccts = [...new Set((r.out.split(/^--- assoc$/m)[1] ?? "").split(/^--- default$/m)[0].trim().split("\n").map((l) => l.split("|")[0]).filter(Boolean))];
  account = defaultAcct || assocAccts[0];
  raw.hpcParsed = { parts, assocAccts, defaultAcct, partition, account };
  const f = kv(r.out);
  return `${f.SLURM} on ${f.HOST} · ${parts.length} partitions (default ${partition}) · ${assocAccts.length} account association(s)`;
});
/**
 * Reason Slurm gave for refusing a request. Formats seen: "sbatch: error: Batch job submission failed: <r>"
 * and (Slurm 24.11 --test-only) "allocation failure: <r>".
 */
export function parseRejection(text) {
  const m = /^(?:sbatch:\s*)?(?:error:\s*(?:Batch job submission failed:\s*)?|allocation failure:\s*)(.+)$/m.exec(text);
  return m?.[1].trim();
}

const job = `#!/bin/bash\n#SBATCH -J cairn-spike\nhostname\n`;
const sbatchTest = (extra) =>
  [`sbatch --test-only ${partition ? `-p '${partition}'` : ""} ${account ? `-A '${account}'` : ""} ${extra} 2>&1 <<'JOB'`, job.trimEnd(), "JOB"].join("\n");
await check(`${H}: sbatch --test-only accepts a small job (nothing submitted)`, async () => {
  const r = await remote(H, sbatchTest("-N 1 -n 1 -t 00:05:00"));
  raw.hpcTestOnly = r;
  const m = /Job (\d+) to start at (\S+) using (\d+) processors on nodes (\S+) in partition (\S+)/.exec(r.out);
  must(m, `unparsed (exit ${r.code}): ${r.out || r.err}`);
  return `would start ${m[2]} on ${m[4]} (${m[3]} procs, partition ${m[5]}); test job id ${m[1]} is not a real submission`;
});
await check(`${H}: sbatch --test-only rejects an oversized job and the reason parses`, async () => {
  const r = await remote(H, sbatchTest("-N 100000 -t 99-00:00:00"));
  raw.hpcOversized = r;
  const reason = parseRejection(r.out);
  must(r.code !== 0 && reason, `expected a Slurm rejection (exit ${r.code}): ${r.out}`);
  return reason;
});

// ---------------- revocation (DR-0006: closing the master revokes all reach) ----------------
if (!opt.keep) {
  for (const host of [W, H]) {
    await check(`${host}: after closing the master, the executor cannot connect`, async () => {
      await sh(["-o", `ControlPath=${CTL}`, "-O", "exit", host]);
      const r = await remote(host, "hostname", { timeout: 30_000 });
      must(r.code !== 0, `still reachable: ${r.out}`);
      return `exit ${r.code}: ${r.err.split("\n").at(-1)}`;
    });
  }
}

console.log("\nM0 spike 4 — executor over user-held SSH ControlMasters\n");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
await writeFile(new URL("./results.json", import.meta.url), JSON.stringify({ results, raw }, null, 2));
console.log("\nraw outputs: spikes/executor-ssh/results.json (gitignored)");
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
