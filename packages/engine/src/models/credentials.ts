// Credential storage for pi-ai, owned by the engine (spike finding C5). One file per auth kind so a
// subscription token and an API key for the same pi provider can coexist. Host only (invariant 1);
// moves to Keychain at M8.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { AuthKind } from "@cairn/shared";

export const secretsDir = (home: string) => join(home, "secrets");
export const storePath = (home: string, kind: AuthKind) => join(secretsDir(home), `${kind}.json`);

type Data = Record<string, Credential>;

/** File-backed CredentialStore: atomic writes, mode 0600, writes serialized in-process. */
export class FileCredentialStore implements CredentialStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async #load(): Promise<Data> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  async #save(data: Data): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async read(id: string): Promise<Credential | undefined> {
    return (await this.#load())[id];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#enqueue(async () => {
      const data = await this.#load();
      const next = await fn(data[id]);
      if (next !== undefined) {
        data[id] = next;
        await this.#save(data);
      }
      return data[id];
    });
  }

  delete(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const data = await this.#load();
      delete data[id];
      await this.#save(data);
    });
  }
}

/**
 * Stable per-installation UUID. Sign in with ChatGPT requires one (spike finding C4); keep it with the
 * credentials so each machine is one install.
 */
export async function deviceId(home: string): Promise<string> {
  const path = join(secretsDir(home), "device-id");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const id = randomUUID();
    await mkdir(secretsDir(home), { recursive: true, mode: 0o700 });
    await writeFile(path, id, { mode: 0o600, flag: "wx" }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    return (await readFile(path, "utf8")).trim();
  }
}
