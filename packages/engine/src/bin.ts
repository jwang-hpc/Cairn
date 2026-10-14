#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";

// Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1 is set at startup (spike finding C2).
// When a proxy is configured, re-exec once with the flag so model calls honor it.
if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && process.env.NODE_USE_ENV_PROXY !== "1") {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(r.status ?? 1);
}

async function readLine(message: string, secret: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  try {
    if (!secret) return (await rl.question(`${message}\n> `)).trim();
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    const write = out._writeToOutput.bind(rl);
    out._writeToOutput = (s: string) => {
      if (s.includes(message) || s.includes("> ")) write(s);
    };
    const answer = await rl.question(`${message}\n> `);
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  write: (chunk) => process.stdout.write(chunk),
  login: {
    show: (m) => process.stdout.write(`${m}\n`),
    ask: readLine,
    choose: async (message, options) => {
      options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.label}\n`));
      const n = Number(await readLine(message, false));
      return options[n - 1]?.id ?? options[0]!.id;
    },
  },
});
