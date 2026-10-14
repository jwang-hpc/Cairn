import { defineConfig } from "vitest/config";

// Escape suite (DR-0005; CLAUDE.md invariants 1-4). Needs a real Apple `container` runtime and the agent
// image, so it runs separately: `pnpm test:escape` (sets CAIRN_ESCAPE=1). Must always pass.
export default defineConfig({
  test: {
    include: ["tests/escape/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
