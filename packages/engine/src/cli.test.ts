import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { ENGINE_VERSION } from "./version.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe("re CLI", () => {
  it("prints the version", async () => {
    const c = capture();
    expect(await runCli(["--version"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain(`re ${ENGINE_VERSION}`);
  });

  it("prints usage with no command", async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("usage: re");
  });

  it("rejects unknown commands with exit code 2", async () => {
    const c = capture();
    expect(await runCli(["frobnicate"], c.io)).toBe(2);
    expect(c.err.join("\n")).toContain("unknown command 'frobnicate'");
  });

  it("rejects unknown options with exit code 2", async () => {
    const c = capture();
    expect(await runCli(["--nope"], c.io)).toBe(2);
  });
});
