import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  EngineConfig,
  MachinesConfig,
  ModelsConfig,
  RolesConfig,
  validate,
  type EngineConfig as EngineConfigT,
  type MachinesConfig as MachinesConfigT,
  type ModelsConfig as ModelsConfigT,
  type RolesConfig as RolesConfigT,
} from "@cairn/shared";
import { crossFileProblems } from "./semantic.js";

export interface LoadedConfig {
  dir: string;
  models: ModelsConfigT;
  roles: RolesConfigT;
  machines: MachinesConfigT;
  engine: EngineConfigT;
}

/** All problems found across config files, each prefixed with the file it came from. */
export class ConfigError extends Error {
  constructor(
    readonly dir: string,
    readonly problems: readonly string[],
  ) {
    super(`invalid configuration in ${dir}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const FILES = {
  models: ModelsConfig,
  roles: RolesConfig,
  machines: MachinesConfig,
  engine: EngineConfig,
} as const;

type Name = keyof typeof FILES;

async function loadOne(dir: string, name: Name, problems: string[]): Promise<unknown> {
  const file = `${name}.yaml`;
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      problems.push(`${file}: not found — copy ${name}.example.yaml to ${file} in ${dir} and edit it`);
      return undefined;
    }
    throw e;
  }

  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      const pos = err.linePos?.[0];
      problems.push(`${file}${pos ? `:${pos.line}:${pos.col}` : ""}: ${err.message.split("\n")[0]}`);
    }
    return undefined;
  }

  const result = validate(FILES[name], doc.toJS());
  if (!result.ok) {
    problems.push(...result.errors.map((e) => `${file}: ${e}`));
    return undefined;
  }
  return result.value;
}

/**
 * Load and validate config/{models,roles,machines,engine}.yaml. Reports every problem found, not just
 * the first; throws ConfigError if there are any.
 */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const problems: string[] = [];
  const [models, roles, machines, engine] = await Promise.all(
    (Object.keys(FILES) as Name[]).map((name) => loadOne(dir, name, problems)),
  );
  if (problems.length > 0) throw new ConfigError(dir, problems);

  const cfg = {
    dir,
    models: models as ModelsConfigT,
    roles: roles as RolesConfigT,
    machines: machines as MachinesConfigT,
    engine: engine as EngineConfigT,
  };
  const semantic = crossFileProblems(cfg);
  if (semantic.length > 0) throw new ConfigError(dir, semantic);
  return cfg;
}
