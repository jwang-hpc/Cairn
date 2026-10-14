import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { setContactEmail } from "./commands.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-lit-config-"));
  const ex = join(import.meta.dirname, "..", "..", "..", "..", "config");
  for (const f of ["models", "roles", "machines", "engine"]) await writeFile(join(dir, `${f}.yaml`), await readFile(join(ex, `${f}.example.yaml`), "utf8"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("literature contact address (OpenAlex/Crossref polite pool)", () => {
  it("is set and cleared in engine.yaml, comments kept, and validated", async () => {
    await setContactEmail(dir, "someone@university.edu");
    const text = await readFile(join(dir, "engine.yaml"), "utf8");
    expect(text).toContain("# Per-machine engine settings.");
    expect((await loadConfig(dir)).engine.literature?.contact_email).toBe("someone@university.edu");
    await setContactEmail(dir, "other@lab.org");
    expect((await loadConfig(dir)).engine.literature?.contact_email).toBe("other@lab.org");
    await setContactEmail(dir, undefined);
    expect((await loadConfig(dir)).engine.literature).toBeUndefined();
    await expect(setContactEmail(dir, "not an email")).rejects.toThrow(/not an email address/);
  });
});
