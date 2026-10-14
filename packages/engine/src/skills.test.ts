import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./paths.js";

const SKILLS = join(REPO_ROOT, "skills");
const front = (text: string) => (parseDocument(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "").toJS() ?? {}) as { name?: unknown; description?: unknown };

async function skills(dir: string): Promise<{ dir: string; name: string; text: string }[]> {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const text = await readFile(join(dir, d.name, "SKILL.md"), "utf8").catch(() => undefined);
    if (text !== undefined) out.push({ dir: join(dir, d.name), name: d.name, text });
  }
  return out;
}

describe("skills (DR-0012)", () => {
  it("every local skill is an Agent Skill named after its folder", async () => {
    for (const s of await skills(join(SKILLS, "local"))) {
      const f = front(s.text);
      expect(f.name, s.name).toBe(s.name);
      expect(typeof f.description === "string" && f.description.length > 20, s.name).toBe(true);
    }
  });

  it("third-party skills that use PiPilot's literature-search tool have local overrides pointing at ours (M7)", async () => {
    const local = new Map((await skills(join(SKILLS, "local"))).map((s) => [s.name, s.text]));
    const vendored = [];
    const sources = (await readdir(join(SKILLS, "third_party"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const src of sources) vendored.push(...(await skills(join(SKILLS, "third_party", src))).map((s) => ({ ...s, src })));
    const using = vendored.filter((s) => /literature-search/.test(s.text));
    expect(using.length).toBeGreaterThan(0);
    for (const s of using) {
      const o = local.get(s.name);
      expect(o, `skills/local/${s.name} overrides ${s.src}/${s.name}`).toBeDefined();
      const path = `/skills/third_party/${s.src}/${s.name}/SKILL.md`;
      expect(o).toContain(`Follow \`${path}\``);
      expect((await stat(join(SKILLS, "third_party", s.src, s.name, "SKILL.md"))).isFile()).toBe(true);
      expect(o).toContain("mcp_literature_resolve");
      expect(String(front(o!).description)).not.toMatch(/literature-search/);
    }
  });
});
