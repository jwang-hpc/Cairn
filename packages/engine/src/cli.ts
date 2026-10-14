import { parseArgs } from "node:util";
import { FORMAT_VERSION } from "@cairn/shared";
import { ENGINE_VERSION } from "./version.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `usage: re <command> [options]

commands:
  help        show this message

options:
  --version   print engine version`;

/** Parse argv (without node/script) and run a command. Returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { version: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    io.err(`re: ${(e as Error).message}`);
    io.err(USAGE);
    return 2;
  }

  if (parsed.values.version) {
    io.out(`re ${ENGINE_VERSION} (format v${FORMAT_VERSION})`);
    return 0;
  }

  const [command] = parsed.positionals;
  if (command === undefined || command === "help" || parsed.values.help) {
    io.out(USAGE);
    return 0;
  }

  io.err(`re: unknown command '${command}'`);
  io.err(USAGE);
  return 2;
}
