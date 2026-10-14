// M0 spike 1 (throwaway): shared helpers for pi-ai auth probing.
// Credentials live only in spikes/pi-auth/.secrets/ (gitignored, mode 600).
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SECRETS_DIR = join(HERE, ".secrets");
export const USAGE_LOG = join(HERE, "usage.jsonl");

// One store file per auth kind so an OAuth token and an API key for the same
// provider can coexist (pi-ai keeps one credential per provider per store).
export const storePath = (kind) => join(SECRETS_DIR, `${kind}.json`);

/** Minimal file-backed CredentialStore. Single-process spike: writes are serialized in-process only. */
export class FileCredentialStore {
  #path;
  #chain = Promise.resolve();
  constructor(path) { this.#path = path; }

  async #load() {
    try { return JSON.parse(await readFile(this.#path, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  }
  async #save(data) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.#path);
  }
  #enqueue(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async read(id) { return (await this.#load())[id]; }
  async list() {
    return Object.entries(await this.#load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  modify(id, fn) {
    return this.#enqueue(async () => {
      const data = await this.#load();
      const next = await fn(data[id]);
      if (next !== undefined) { data[id] = next; await this.#save(data); }
      return data[id];
    });
  }
  delete(id) {
    return this.#enqueue(async () => {
      const data = await this.#load();
      delete data[id];
      await this.#save(data);
    });
  }
}

/** kind: "oauth" | "api_key" */
export function makeModels(kind) {
  const models = createModels({ credentials: new FileCredentialStore(storePath(kind)) });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  // Legacy ChatGPT route (chatgpt.com/backend-api); tested because Sign in with ChatGPT returns 520.
  models.setProvider(openaiCodexProvider());
  return models;
}

/** Pull only the effort-related fields out of a provider payload (never log prompts or headers). */
export function nativeEffort(payload) {
  const p = payload ?? {};
  const pick = {};
  for (const k of ["thinking", "reasoning", "reasoning_effort", "output_config", "effort", "max_tokens", "max_output_tokens", "temperature"]) {
    if (p[k] !== undefined) pick[k] = p[k];
  }
  // Anthropic "managed effort" models (Claude 5.x): top-level output_config is a constant; the
  // effective per-turn effort is a trailing {role:"system", output_config:{effort}} message.
  if (Array.isArray(p.messages)) {
    const efforts = p.messages.filter((m) => m.role === "system" && m.output_config?.effort).map((m) => m.output_config.effort);
    if (efforts.length) pick.turnEffort = efforts.at(-1);
  }
  // Report whether the OAuth path injected the Claude Code identity (text not logged).
  if (Array.isArray(p.system)) pick.claudeCodeIdentity = p.system.some((s) => s.text?.startsWith("You are Claude Code"));
  return pick;
}

/** Append one normalized usage record (invariant 6 shape, approximated for the spike). */
export async function logCall(rec) {
  const line = { ts: new Date().toISOString(), machine: hostname(), ...rec };
  await appendFile(USAGE_LOG, JSON.stringify(line) + "\n");
  return line;
}
