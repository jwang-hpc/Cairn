// Job lint (DR-0006 step 2): every job is checked against its machine's policy before anyone is asked to approve
// it. Resource limits are exact; the shell scan is a heuristic guard (the approval card still shows every file):
// no remote access, no privilege changes, nothing that outlives the job, no destructive commands outside the job
// directory, no paths outside the machine's project/scratch areas.
import {
  JOB_FILE_PATTERN,
  type JobLint,
  JobManifest as JobManifestSchema,
  type JobManifest,
  type MachineConfig,
  validate,
} from "@cairn/shared";

export const MANIFEST_FILE = "job.json";
export const LIMITS = { files: 100, fileBytes: 1 << 20, totalBytes: 4 << 20 } as const;

export interface JobFileContent {
  path: string;
  content: Buffer;
}

export interface LintInput {
  target: string;
  machine: MachineConfig | undefined;
  /** Every file of experiments/EXP-NNN/, paths relative to it (job.json included). */
  files: JobFileContent[];
}

export interface LintOutcome {
  lint: JobLint;
  manifest: JobManifest | undefined;
}

export const walltimeSeconds = (w: string): number => {
  const [h = 0, m = 0, s = 0] = w.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

const FILE_RE = new RegExp(JOB_FILE_PATTERN);
const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0);

export function lintJob({ target, machine, files }: LintInput): LintOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = (): LintOutcome => ({ lint: { errors, warnings, nodes: 0, cores: 0, gpus: 0, walltime_s: 0, node_hours: 0 }, manifest: undefined });

  if (!machine) {
    errors.push(`unknown target '${target}' (not in machines.yaml)`);
    return empty();
  }
  if (machine.scheduler === "pbs") errors.push(`${target}: PBS submission is not implemented yet`);
  if (!machine.scratch) errors.push(`${target}: machines.yaml has no scratch path for job directories`);

  // Files: names, count, size.
  if (files.length > LIMITS.files) errors.push(`too many files (${files.length} > ${LIMITS.files})`);
  let total = 0;
  for (const f of files) {
    total += f.content.length;
    if (!FILE_RE.test(f.path)) errors.push(`file name not allowed: ${JSON.stringify(f.path)}`);
    if (f.content.length > LIMITS.fileBytes) errors.push(`${f.path} is larger than ${LIMITS.fileBytes} bytes; keep data on the machine and reference it by path`);
  }
  if (total > LIMITS.totalBytes) errors.push(`job files total ${total} bytes (> ${LIMITS.totalBytes})`);

  // Manifest.
  const mf = files.find((f) => f.path === MANIFEST_FILE);
  if (!mf) {
    errors.push(`missing ${MANIFEST_FILE}`);
    return empty();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(mf.content.toString("utf8"));
  } catch (e) {
    errors.push(`${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`);
    return empty();
  }
  const parsed = validate(JobManifestSchema, raw);
  if (!parsed.ok) {
    errors.push(...parsed.errors.map((x) => `${MANIFEST_FILE}: ${x}`));
    return empty();
  }
  const manifest = parsed.value;
  const r = manifest.resources;

  // Resources against the machine.
  const nodes = r.nodes ?? 1;
  const gpus = r.gpus ?? 0;
  const walltime_s = walltimeSeconds(r.walltime);
  const max = machine.max ?? {};
  if (machine.scheduler === "none" && nodes !== 1) errors.push(`${target} has no scheduler: nodes must be 1, not ${nodes}`);
  if (max.nodes !== undefined && nodes > max.nodes) errors.push(`nodes ${nodes} exceeds ${target} max ${max.nodes}`);
  if (max.cores !== undefined && r.cores > max.cores) errors.push(`cores ${r.cores} exceeds ${target} max ${max.cores} per node`);
  if (max.gpus !== undefined && gpus > max.gpus) errors.push(`gpus ${gpus} exceeds ${target} max ${max.gpus} per node`);
  if (max.walltime !== undefined && walltime_s > walltimeSeconds(max.walltime)) errors.push(`walltime ${r.walltime} exceeds ${target} max ${max.walltime}`);
  if (walltime_s === 0) errors.push("walltime must be more than 00:00:00");
  if (r.tasks_per_node !== undefined) {
    if (machine.scheduler !== "slurm") errors.push("tasks_per_node applies to Slurm machines only");
    else if (r.cores % r.tasks_per_node !== 0) errors.push(`tasks_per_node ${r.tasks_per_node} must divide cores ${r.cores}`);
  }
  let partition: string | undefined;
  if (machine.scheduler === "slurm") {
    partition = r.partition ?? machine.partitions?.[0];
    if (machine.partitions && partition && !machine.partitions.includes(partition)) {
      errors.push(`partition '${partition}' is not allowed on ${target} (allowed: ${machine.partitions.join(", ")})`);
    }
    if (!machine.partitions) warnings.push(`${target} has no partition allowlist in machines.yaml`);
  } else if (r.partition !== undefined) {
    errors.push(`${target} has no scheduler; remove resources.partition`);
  }

  // Script and outputs.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const script = byPath.get(manifest.script);
  if (!script) errors.push(`script ${manifest.script} is not in the experiment directory`);
  else if (!isText(script.content)) errors.push(`script ${manifest.script} is not a text file`);
  if (new Set(manifest.outputs).size !== manifest.outputs.length) errors.push("outputs lists a file twice");

  // Credential locations, in any language: fetched outputs end up in the ledger and in model context.
  const roots = [...(machine.paths?.allowed_prefixes ?? []), ...(machine.scratch ? [machine.scratch] : [])];
  for (const f of files) {
    if (!isText(f.content)) continue;
    const text = f.content.toString("utf8");
    text.split("\n").forEach((line, i) => {
      const m = SECRETS.exec(line);
      if (m) errors.push(`${f.path}:${i + 1}: references '${m[0]}', a credential location; jobs must not read credentials`);
    });
    // Shell scan: the entry script plus anything that looks like a shell script.
    const shell = f.path === manifest.script || /\.(sh|bash)$/.test(f.path) || /^#!.*\b(ba)?sh\b/.test(text);
    if (shell) scanShell(f.path, text, { target, roots }, errors, warnings);
  }

  const lint: JobLint = {
    errors,
    warnings,
    nodes,
    cores: r.cores,
    gpus,
    walltime_s,
    node_hours: Math.round(nodes * (walltime_s / 3600) * 1000) / 1000,
    ...(partition ? { partition } : {}),
    ...(machine.scheduler === "slurm" && machine.account ? { account: machine.account } : {}),
  };
  return { lint, manifest };
}

/**
 * Auto-approval (DR-0006 step 3): never on DOE machines, only below the machine's thresholds, never with lint
 * warnings, and only for an exact rerun of files the user already approved (the "approved template").
 */
export function autoApproval(target: string, machine: MachineConfig, lint: JobLint, approvedBefore: boolean): { ok: boolean; reason: string } {
  if (machine.doe) return { ok: false, reason: `${target} is a DOE machine: always needs your approval` };
  const t = machine.auto_approve_below;
  if (!t || (t.cores === undefined && t.hours === undefined && t.node_hours === undefined)) return { ok: false, reason: `${target} has no auto-approval threshold` };
  if (lint.errors.length > 0) return { ok: false, reason: "lint errors" };
  if (lint.warnings.length > 0) return { ok: false, reason: "lint warnings need your review" };
  if (!approvedBefore) return { ok: false, reason: "new job files: you approve each new script once; identical reruns may auto-approve" };
  const over: string[] = [];
  const hours = lint.walltime_s / 3600;
  if (t.cores !== undefined && !(lint.nodes * lint.cores < t.cores)) over.push(`cores ${lint.nodes * lint.cores} ≥ ${t.cores}`);
  if (t.hours !== undefined && !(hours < t.hours)) over.push(`hours ${hours} ≥ ${t.hours}`);
  if (t.node_hours !== undefined && !(lint.node_hours < t.node_hours)) over.push(`node-hours ${lint.node_hours} ≥ ${t.node_hours}`);
  if (over.length > 0) return { ok: false, reason: `above the auto-approval threshold (${over.join(", ")})` };
  return { ok: true, reason: `identical rerun of approved files, below the ${target} threshold` };
}

// ---------- shell scan ----------

/** Never in a job: remote access, privilege changes, persistence, escaping the job's lifetime, scheduler control. */
const BANNED: Record<string, string> = {
  ssh: "remote access goes through the executor only",
  scp: "remote access goes through the executor only",
  sftp: "remote access goes through the executor only",
  rsh: "remote access goes through the executor only",
  rlogin: "remote access goes through the executor only",
  telnet: "remote access goes through the executor only",
  sudo: "no privilege changes",
  su: "no privilege changes",
  doas: "no privilege changes",
  crontab: "no persistence",
  at: "no persistence",
  systemctl: "no persistence",
  "systemd-run": "no persistence",
  loginctl: "no persistence",
  nohup: "processes must not outlive the job",
  setsid: "processes must not outlive the job",
  disown: "processes must not outlive the job",
  screen: "processes must not outlive the job",
  tmux: "processes must not outlive the job",
  sbatch: "jobs must not submit other jobs",
  qsub: "jobs must not submit other jobs",
  scancel: "jobs must not control the scheduler",
  qdel: "jobs must not control the scheduler",
  pkill: "may kill processes outside the job",
  killall: "may kill processes outside the job",
  shutdown: "not allowed",
  reboot: "not allowed",
  halt: "not allowed",
  poweroff: "not allowed",
  mkfs: "not allowed",
  fdisk: "not allowed",
  parted: "not allowed",
};
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "ftp", "aria2c"]);
const INSTALLERS: Record<string, string[]> = {
  pip: ["install", "download"], pip3: ["install", "download"], conda: ["install", "create", "update"], mamba: ["install", "create", "update"],
  apt: ["install"], "apt-get": ["install"], yum: ["install"], dnf: ["install"], npm: ["install", "i", "ci"], pnpm: ["install", "add"], yarn: ["add", "install"],
};
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python3", "perl", "ruby", "node"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "shred", "truncate", "chmod", "chown", "chgrp", "unlink", "ln", "cp", "dd", "find"]);
const WRAPPERS = new Set(["time", "exec", "command", "builtin", "nice", "ionice", "stdbuf", "env"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
/** Their arguments are patterns or text, not paths ('/foo/p' is a sed address). */
const TEXT_ARGS = new Set(["sed", "awk", "gawk", "grep", "egrep", "fgrep", "perl", "printf", "echo"]);
const SYSTEM_READ = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/opt/", "/etc/", "/proc/", "/sys/"];
const ALWAYS_OK = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/stdout", "/dev/stderr", "/dev/shm/", "/tmp/"];
/** Credential files and directories (any language). */
const SECRETS = /\.ssh\b|\bid_(rsa|ecdsa|ed25519|dsa)\b|authorized_keys|\.netrc\b|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.git-credentials|\.pgpass|\.vault-token|\.gnupg|\.engine\/secrets|\.claude\b|\.codex\b/;
const PROTECTED = /(^|\/)(\.ssh|authorized_keys|\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.config\/systemd|\.config\/autostart)(\/|$)/;

const under = (p: string, prefix: string) => (prefix.endsWith("/") ? p.startsWith(prefix) || `${p}/` === prefix : p === prefix || p.startsWith(`${prefix.replace(/\/+$/, "")}/`));
const isHome = (w: string) => w === "~" || w.startsWith("~/") || /^\$\{?HOME\}?(\/|$)/.test(w);

interface Cmd {
  words: string[];
  /** Write redirections (> file, >> file). */
  writes: string[];
  piped: boolean;
  background: boolean;
}

/** Split one logical line into simple commands. Quote-aware; good enough for a guard, not a shell. */
function lexLine(line: string): { cmds: Cmd[]; heredocs: string[] } {
  const cmds: Cmd[] = [];
  const heredocs: string[] = [];
  let cur: Cmd = { words: [], writes: [], piped: false, background: false };
  let word = "";
  let inWord = false;
  let pending: "write" | "heredoc" | "read" | null = null;
  const endWord = () => {
    if (!inWord) return;
    if (pending === "write") cur.writes.push(word);
    else if (pending === "heredoc") heredocs.push(word.replace(/^-/, ""));
    else if (pending !== "read") cur.words.push(word);
    pending = null;
    word = "";
    inWord = false;
  };
  const endCmd = (next: { piped?: boolean; background?: boolean } = {}) => {
    endWord();
    if (next.background) cur.background = true;
    if (cur.words.length > 0 || cur.writes.length > 0) cmds.push(cur);
    cur = { words: [], writes: [], piped: next.piped === true, background: false };
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      word += close === -1 ? line.slice(i + 1) : line.slice(i + 1, close);
      inWord = true;
      i = close === -1 ? line.length : close;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "$" && line[i + 1] === "{") {
      const close = line.indexOf("}", i);
      word += close === -1 ? line.slice(i) : line.slice(i, close + 1);
      inWord = true;
      i = close === -1 ? line.length : close;
    } else if (c === "$" && line[i + 1] === "(") {
      endCmd();
      i++;
    } else if (c === ";" || c === "(" || c === ")" || c === "`" || c === "{" || c === "}") {
      endCmd();
    } else if (c === "|") {
      const or = line[i + 1] === "|";
      if (or) i++;
      endCmd({ piped: !or });
    } else if (c === "&") {
      if (line[i + 1] === "&") {
        i++;
        endCmd();
      } else if (line[i + 1] === ">") {
        endWord();
        i++;
        if (line[i + 1] === ">") i++;
        pending = "write";
      } else {
        endCmd({ background: true });
      }
    } else if (c === ">" || c === "<") {
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let op = c;
      while (line[i + 1] === ">" || line[i + 1] === "<" || line[i + 1] === "&") op += line[++i];
      if (op.includes("&")) {
        // fd duplication (2>&1): skip the fd number that follows
        while (/\d|-/.test(line[i + 1] ?? "")) i++;
        pending = null;
      } else if (op.startsWith("<<<")) pending = "read";
      else if (op.startsWith("<<")) pending = "heredoc";
      else pending = op.startsWith(">") ? "write" : "read";
    } else {
      word += c;
      inWord = true;
    }
  }
  endCmd();
  return { cmds, heredocs };
}

/** Remove a comment: '#' at the start of a word, outside quotes. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function commandName(words: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) i++;
    else if (WRAPPERS.has(w)) {
      i++;
      while (i < words.length && words[i]!.startsWith("-")) i++;
    } else if (w === "timeout") {
      i++;
      while (i < words.length && words[i]!.startsWith("-")) i++;
      i++; // duration
    } else break;
  }
  if (i >= words.length) return undefined;
  const name = words[i]!.split("/").at(-1)!;
  return { name, args: words.slice(i + 1) };
}

function scanShell(file: string, text: string, ctx: { target: string; roots: string[] }, errors: string[], warnings: string[]): void {
  const lines = text.split("\n");
  const err = (n: number, m: string) => errors.push(`${file}:${n}: ${m}`);
  const warn = (n: number, m: string) => warnings.push(`${file}:${n}: ${m}`);
  const allowed = (p: string, write: boolean) =>
    ctx.roots.some((r) => under(p, r)) || ALWAYS_OK.some((r) => under(p, r)) || (!write && SYSTEM_READ.some((r) => under(p, r)));

  const checkPath = (n: number, raw: string, write: boolean) => {
    const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    for (const w of new Set([raw, ...value.split(":")])) {
      if (w.split("/").includes("..")) err(n, `'${raw}': no '..' paths; stay inside the job directory`);
      if (PROTECTED.test(w) && (w.startsWith("/") || isHome(w))) err(n, `'${raw}' touches login or SSH configuration`);
      else if (isHome(w)) warn(n, `'${raw}' uses the home directory; job data belongs in scratch`);
      else if (w.startsWith("/") && !allowed(w, write)) {
        err(n, `${write ? "writes to" : "uses"} ${w}, outside the project/scratch areas allowed on ${ctx.target}`);
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (/^\s*#(SBATCH|PBS)\b/.test(lines[i]!)) {
      err(n, "scheduler directives are not allowed; resources come from job.json and the executor writes the header");
      continue;
    }
    let line = stripComment(lines[i]!);
    while (line.trimEnd().endsWith("\\") && i + 1 < lines.length) line = line.trimEnd().slice(0, -1) + " " + stripComment(lines[++i]!);
    const { cmds, heredocs } = lexLine(line);
    for (const cmd of cmds) {
      for (const w of cmd.writes) checkPath(n, w, true);
      const c = commandName(cmd.words);
      const pathWords = c && TEXT_ARGS.has(c.name) ? cmd.words.slice(0, cmd.words.length - c.args.length - 1) : cmd.words;
      for (const w of pathWords) checkPath(n, w, false);
      if (!c) continue;
      const { name, args } = c;
      if (name in BANNED || /^mkfs\./.test(name)) err(n, `'${name}' is not allowed in jobs (${BANNED[name] ?? "not allowed"})`);
      if (name === "rsync" && args.some((a) => /^[^/-][^/]*:/.test(a))) err(n, "rsync to a remote host; remote access goes through the executor only");
      if (name === "git" && args.includes("push")) err(n, "'git push' is not allowed in jobs");
      else if (name === "git" && args.some((a) => ["clone", "fetch", "pull", "ls-remote", "submodule"].includes(a))) warn(n, "git uses the network; check the source");
      if (NETWORK.has(name)) warn(n, `'${name}' uses the network; check where it connects`);
      if (INSTALLERS[name] && args.some((a) => INSTALLERS[name]!.includes(a))) warn(n, `'${name} ${args[0]}' installs packages from the network`);
      if (cmd.piped && INTERPRETERS.has(name)) err(n, `piping text into '${name}' is not allowed (download-and-run)`);
      if (name === "eval") warn(n, "'eval' hides what runs; check it");
      if (cmd.background) warn(n, "starts a background process; it may outlive the job's time limit");
      if (name === "cd") {
        const d = args[0];
        if (d === undefined || isHome(d)) err(n, "'cd' to the home directory; stay inside the job directory");
      }
      if (DESTRUCTIVE.has(name)) {
        const operands = args.filter((a) => !a.startsWith("-"));
        const targets =
          name === "cp" ? operands.slice(-1)
          : name === "dd" ? args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3))
          : name === "find" ? (args.includes("-delete") || args.includes("-exec") ? operands.slice(0, 1) : [])
          : operands;
        for (const t of targets) {
          if (t.startsWith("/") || isHome(t)) err(n, `'${name} ${t}': destructive commands may only touch files inside the job directory`);
          else if (t.startsWith("$")) warn(n, `'${name} ${t}': check that the variable stays inside the job directory`);
        }
      }
    }
    // Skip heredoc bodies: they are data, not commands.
    for (const delim of heredocs) {
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== delim) i++;
      i++;
    }
  }
}
