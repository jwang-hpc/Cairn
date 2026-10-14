import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, git, outsideAllowed, removeWorktree, worktreeDiff, WorktreeError } from "./worktree.js";

let base: string;
let repo: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-wt-"));
  repo = join(base, "project");
  root = join(base, "engine", "worktrees");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "logic"), { recursive: true });
  await writeFile(join(repo, "src", "main.py"), "print('v1')\n");
  await writeFile(join(repo, "logic", "claims.md"), "# claims\n");
  await writeFile(join(repo, "README.md"), "project\n");
  await git(repo, ["init", "--quiet", "-b", "main"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"]);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates <root>/<id> on branch agent/<id> at the base commit", async () => {
    const ref = await createWorktree({ repo, agentId: "a1", root });
    expect(ref.path).toBe(join(root, "a1"));
    expect(ref.branch).toBe("agent/a1");
    expect(ref.base).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(ref.path, "src", "main.py"), "utf8")).toBe("print('v1')\n");
    expect((await git(ref.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("agent/a1");
    // The project tree itself is untouched by the agent's worktree.
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refuses duplicate ids, bad ids, and non-repositories", async () => {
    await createWorktree({ repo, agentId: "a1", root });
    await expect(createWorktree({ repo, agentId: "a1", root })).rejects.toThrow(/already exists/);
    await expect(createWorktree({ repo, agentId: "../x", root })).rejects.toThrow(/invalid agent id/);
    await expect(createWorktree({ repo: base, agentId: "a2", root })).rejects.toThrow(/not a git repository/);
  });
});

describe("worktreeDiff", () => {
  it("captures edits, new files, and deletions against the base", async () => {
    const ref = await createWorktree({ repo, agentId: "a1", root });
    await writeFile(join(ref.path, "src", "main.py"), "print('v2')\n");
    await writeFile(join(ref.path, "src", "util.py"), "X = 1\n");
    await unlink(join(ref.path, "README.md"));
    const { diff, files } = await worktreeDiff(ref);
    expect(files).toEqual([
      { path: "README.md", status: "deleted" },
      { path: "src/main.py", status: "modified" },
      { path: "src/util.py", status: "added" },
    ]);
    expect(diff).toContain("-print('v1')");
    expect(diff).toContain("+print('v2')");
    expect(diff).toContain("+X = 1");
  });

  it("ignores a repo's external diff drivers (no code execution from repo config)", async () => {
    const ref = await createWorktree({ repo, agentId: "a1", root });
    await git(repo, ["config", "diff.evil.command", `touch ${join(base, "PWNED")}`]);
    await writeFile(join(ref.path, ".gitattributes"), "*.py diff=evil\n");
    await writeFile(join(ref.path, "src", "main.py"), "print('v3')\n");
    await worktreeDiff(ref);
    await expect(stat(join(base, "PWNED"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("outsideAllowed", () => {
  it("flags changes outside the role's write paths", () => {
    const files = [{ path: "src/main.py" }, { path: "src" }, { path: "experiments/EXP-001/job.sh" }, { path: "logic/claims.md" }, { path: "srcx/a" }];
    expect(outsideAllowed(files, ["src/", "experiments/"])).toEqual(["logic/claims.md", "srcx/a"]);
    expect(outsideAllowed([{ path: "notes.md" }, { path: "notes.md.bak" }], ["notes.md"])).toEqual(["notes.md.bak"]);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and branch, and is idempotent", async () => {
    const ref = await createWorktree({ repo, agentId: "a1", root });
    await writeFile(join(ref.path, "scratch.txt"), "uncommitted\n");
    await removeWorktree(ref, { deleteBranch: true });
    await expect(stat(ref.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(repo, ["branch", "--list", "agent/a1"])).trim()).toBe("");
    await expect(removeWorktree(ref, { deleteBranch: true })).resolves.toBeUndefined();
  });

  it("surfaces git failures as WorktreeError", async () => {
    await expect(git(base, ["status"])).rejects.toBeInstanceOf(WorktreeError);
  });
});

describe("commitWorktree", () => {
  it("commits agent changes on agent/<id> under the agent identity, or nothing if unchanged", async () => {
    const { commitWorktree } = await import("./worktree.js");
    const ref = await createWorktree({ repo, agentId: "a1", root });
    expect(await commitWorktree(ref, "agent a1: nothing")).toBeUndefined();
    await writeFile(join(ref.path, "src", "new.py"), "Y = 2\n");
    const sha = await commitWorktree(ref, "agent a1 (coder): add new.py");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(repo, ["log", "-1", "--format=%an <%ae>|%s", "agent/a1"])).trim()).toBe("Cairn agent <agent@cairn.invalid>|agent a1 (coder): add new.py");
    expect((await git(repo, ["diff", "--name-only", `${ref.base}...agent/a1`])).trim()).toBe("src/new.py");
    // main is untouched
    expect((await git(repo, ["rev-parse", "main"])).trim()).toBe(ref.base);
  });
});
