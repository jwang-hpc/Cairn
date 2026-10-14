// Engine side of the literature service (M7): the cache in the engine home, the contact address from engine.yaml,
// and the optional Semantic Scholar key from the secrets folder (host only; never in config, git, or a container).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LitHttp, type LitHttpOptions, LiteratureService } from "@cairn/executor";
import type { Engine } from "../engine.js";
import { secretsDir } from "../models/credentials.js";

const keysPath = (home: string) => join(secretsDir(home), "literature.json");

export async function readLiteratureKeys(home: string): Promise<{ s2?: string }> {
  try {
    return JSON.parse(await readFile(keysPath(home), "utf8")) as { s2?: string };
  } catch {
    return {};
  }
}

export async function setLiteratureKey(home: string, service: "s2", key: string | undefined): Promise<void> {
  const keys = await readLiteratureKeys(home);
  if (key === undefined) delete keys[service];
  else {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new Error("that doesn't look like an API key");
    keys[service] = key;
  }
  await mkdir(secretsDir(home), { recursive: true, mode: 0o700 });
  if (Object.keys(keys).length === 0) await rm(keysPath(home), { force: true });
  else await writeFile(keysPath(home), `${JSON.stringify(keys)}\n`, { mode: 0o600 });
}

/** Test seams: a fake fetch and no pacing waits. */
export type LiteratureDeps = Pick<LitHttpOptions, "fetch" | "sleep">;

export async function openLiteratureService(engine: Engine, deps: LiteratureDeps = {}): Promise<LiteratureService> {
  const keys = await readLiteratureKeys(engine.paths.home);
  const email = engine.config.engine.literature?.contact_email;
  return new LiteratureService(
    new LitHttp({
      cacheDir: join(engine.paths.home, "literature-cache"),
      ...(email ? { contactEmail: email } : {}),
      ...(keys.s2 ? { s2Key: keys.s2 } : {}),
      ...deps,
    }),
  );
}
