import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore, deviceId, secretsDir, storePath } from "./credentials.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-creds-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("FileCredentialStore", () => {
  it("round-trips credentials in a private file and lists without secrets", async () => {
    const store = new FileCredentialStore(storePath(home, "api_key"));
    await store.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-test" });
    expect(await store.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
    expect((await stat(storePath(home, "api_key"))).mode & 0o777).toBe(0o600);
    expect((await stat(secretsDir(home))).mode & 0o777).toBe(0o700);
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
  });

  it("serializes concurrent modifications (refresh-under-lock contract)", async () => {
    const store = new FileCredentialStore(storePath(home, "oauth"));
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.modify(`p${i}`, async () => ({ type: "oauth", access: `a${i}`, refresh: "r", expires: 1 })),
      ),
    );
    expect(await store.list()).toHaveLength(25);
  });
});

describe("deviceId", () => {
  it("is a stable UUID per engine home", async () => {
    const a = await deviceId(home);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await deviceId(home)).toBe(a);
  });
});
