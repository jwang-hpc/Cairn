import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RolesConfig } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRunArgv, toRunArgv } from "./argv.js";
import { MountError, prepareMounts } from "./mounts.js";
import { specForRole } from "./policy.js";

let base: string;
let worktree: string;
let skills: string;
let outbox: string;
let secret: string;

const roles = (read: string[], write: string[]): RolesConfig => ({
  roles: { r: { mounts: { read, write }, network: [], executor_tools: [] } },
  defaults: { secrets: "none", egress: "deny" },
});
const spec = (read: string[], write: string[] = []) =>
  specForRole({ agentId: "t1", role: "r", roles: roles(read, write), worktree, skillsDir: skills, outboxDir: outbox, image: "img", network: "cairn-net-t1" });
const roots = () => ({ worktree, skills, outbox });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-mounts-"));
  worktree = join(base, "wt");
  skills = join(base, "skills");
  outbox = join(base, "outbox", "t1");
  secret = join(base, "home", ".ssh");
  await mkdir(join(worktree, "logic"), { recursive: true });
  await mkdir(skills, { recursive: true });
  await mkdir(secret, { recursive: true });
  await writeFile(join(secret, "id_ed25519"), "PRIVATE");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("prepareMounts", () => {
  it("returns real paths, creates missing dirs and the outbox, and yields an argv the allowlist accepts", async () => {
    const p = await prepareMounts(spec(["logic/"], ["analysis/"]), roots());
    expect((await stat(join(worktree, "analysis"))).isDirectory()).toBe(true);
    expect((await stat(outbox)).isDirectory()).toBe(true);
    const realWt = await realpath(worktree);
    expect(p.spec.mounts.find((m) => m.target === "/work/logic")!.source).toBe(join(realWt, "logic"));
    // Real roots + real sources pass the string-level allowlist (macOS: /var -> /private/var).
    expect(() => validateRunArgv(toRunArgv(p.spec, { roots: p.roots, network: "cairn-net-t1" }), { roots: p.roots, network: "cairn-net-t1" })).not.toThrow();
  });

  it("refuses a mount source that is a symlink out of the worktree (e.g. committed logic -> ~/.ssh)", async () => {
    await symlink(secret, join(worktree, "evidence"));
    await expect(prepareMounts(spec(["evidence/"]), roots())).rejects.toThrow(/resolves outside its root|outside its root/);
  });

  it("refuses a mount under a symlinked parent", async () => {
    await symlink(join(base, "home"), join(worktree, "drafts"));
    await expect(prepareMounts(spec(["drafts/.ssh/"]), roots())).rejects.toThrow(MountError);
  });

  it("refuses a symlinked worktree root pointing elsewhere only if mounts escape the real root", async () => {
    // A symlink *inside* the root that stays inside is fine.
    await mkdir(join(worktree, "real-src"), { recursive: true });
    await symlink(join(worktree, "real-src"), join(worktree, "src"));
    const p = await prepareMounts(spec(["src/"]), roots());
    expect(p.spec.mounts[0]!.source).toBe(join(await realpath(worktree), "real-src"));
  });

  it("drops missing read-only files, but refuses missing writable files and kind mismatches", async () => {
    const p = await prepareMounts(spec(["logic/experiments.md"]), roots());
    expect(p.skipped.map((m) => m.target)).toEqual(["/work/logic/experiments.md"]);
    expect(p.spec.mounts.some((m) => m.target === "/work/logic/experiments.md")).toBe(false);

    await expect(prepareMounts(spec([], ["notes.md"]), roots())).rejects.toThrow(/writable file mount .* does not exist/);
    await writeFile(join(worktree, "evidence"), "not a dir");
    await expect(prepareMounts(spec(["evidence/"]), roots())).rejects.toThrow(/is not a directory/);
  });

  it("requires the worktree and skills to exist", async () => {
    await rm(skills, { recursive: true });
    await expect(prepareMounts(spec(["logic/"]), roots())).rejects.toThrow(/skills directory does not exist/);
  });
});
