import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../paths.js";
import { ConfigError, loadConfig } from "./load.js";

const NAMES = ["models", "roles", "machines", "engine"] as const;
let dir: string;

/** Fresh temp config dir populated from the checked-in examples. */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-config-"));
  for (const n of NAMES) await copyFile(join(REPO_ROOT, "config", `${n}.example.yaml`), join(dir, `${n}.yaml`));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function edit(name: (typeof NAMES)[number], fn: (text: string) => string) {
  const p = join(dir, `${name}.yaml`);
  await writeFile(p, fn(await readFile(p, "utf8")));
}

async function problems(): Promise<readonly string[]> {
  try {
    await loadConfig(dir);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe("loadConfig", () => {
  it("loads the checked-in example configs", async () => {
    const cfg = await loadConfig(dir);
    expect(cfg.engine.machine).toBe("mbp");
    expect(cfg.models.providers.openai?.routes[0]).toEqual({ pi_provider: "openai-codex", auth: "oauth" });
    expect(Object.keys(cfg.roles.roles)).toContain("coder");
    expect(cfg.machines.machines.bebop?.doe).toBe(true);
  });

  it("names the example to copy when a file is missing", async () => {
    await rm(join(dir, "engine.yaml"));
    expect(await problems()).toEqual([`engine.yaml: not found — copy engine.example.yaml to engine.yaml in ${dir} and edit it`]);
  });

  it("reports YAML syntax errors with file and line", async () => {
    await edit("roles", (t) => `${t}\ndefaults: { secrets: none }\n`); // duplicate key
    const p = await problems();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^roles\.yaml:\d+:\d+: Map keys must be unique/);
  });

  it("reports schema errors from every file at once, file-qualified", async () => {
    await edit("models", (t) => t.replace("auth: oauth }      # Claude", "auth: password }      # Claude"));
    await edit("engine", (t) => t.replace("max_turns: 30", "max_turns: 0"));
    const p = await problems();
    expect(p).toContain('models.yaml: providers.anthropic.routes[0].auth: must be one of "oauth", "api_key"');
    expect(p.some((x) => x.startsWith("engine.yaml: budget.run.max_turns:"))).toBe(true);
  });

  it("rejects a model whose provider is not configured", async () => {
    await edit("models", (t) => t.replace("claude-haiku:    { provider: anthropic", "claude-haiku:    { provider: anthropik"));
    expect(await problems()).toContain(
      "models.yaml: models.claude-haiku.provider: unknown provider 'anthropik' (known: anthropic, openai, google, microsoft)",
    );
  });

  it("rejects a provider in use without an effort mapping", async () => {
    await edit("models", (t) => t.replace(/^ {2}google: {4}\{ low.*$/m, ""));
    expect(await problems()).toContain("models.yaml: effort_map: missing entry for provider 'google' (used by gemini-frontier)");
  });

  it("rejects routing references to unknown aliases", async () => {
    await edit("models", (t) => t.replace("panel: [claude-opus@high, gpt-frontier@high]", "panel: [claude-opus@high, gpt-6@high]"));
    expect(await problems()).toContain("models.yaml: routing.critique.panel[1]: unknown model alias 'gpt-6'");
  });

  it("never lets a DOE machine auto-approve (DR-0006)", async () => {
    await edit("machines", (t) => t.replace("doe: true ", "doe: true\n    auto_approve_below: { node_hours: 1 }\n   "));
    expect(await problems()).toContain(
      "machines.yaml: machines.bebop.auto_approve_below: DOE machines are never auto-approved (DR-0006)",
    );
  });

  it("requires DOE machines to declare allowed path prefixes", async () => {
    await edit("machines", (t) => t.replace(/^ {4}paths: .*$/m, ""));
    expect(await problems()).toContain("machines.yaml: machines.bebop.paths: DOE machines must declare allowed_prefixes (DR-0006)");
  });

  it("rejects budget caps for unknown providers and roles", async () => {
    await edit("engine", (t) =>
      t.replace("per_provider: { anthropic: 5, openai: 5 }", "per_provider: { anthropic: 5, gemini: 5 }").replace(
        "# per_role: { coder: { usd: 3 } }",
        "per_role: { reviewer: { usd: 3 } }",
      ),
    );
    const p = await problems();
    expect(p).toContain("engine.yaml: budget.daily.usd.per_provider.gemini: unknown provider (known: anthropic, openai, google, microsoft)");
    expect(p).toContain("engine.yaml: budget.daily.per_role.reviewer: unknown role (known: literature, coder, analysis, panel, writer)");
  });
});
