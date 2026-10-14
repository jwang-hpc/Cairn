import { describe, expect, it } from "vitest";
import { FORMAT_VERSION } from "./index.js";

describe("@cairn/shared", () => {
  it("exposes a positive integer format version", () => {
    expect(Number.isInteger(FORMAT_VERSION)).toBe(true);
    expect(FORMAT_VERSION).toBeGreaterThan(0);
  });
});
