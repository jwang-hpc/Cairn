import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo checkout root, derived from this module's location (packages/engine/{src,dist}/paths.*). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface EnginePaths {
  /** Real configs (gitignored). */
  configDir: string;
  /** Engine state: event log, usage.jsonl, credentials (gitignored). Moves to App Support + Keychain at M8. */
  home: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): EnginePaths {
  return {
    configDir: resolve(env.CAIRN_CONFIG_DIR ?? resolve(REPO_ROOT, "config")),
    home: resolve(env.CAIRN_HOME ?? resolve(REPO_ROOT, ".engine")),
  };
}
