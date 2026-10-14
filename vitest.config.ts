import { defineConfig } from "vitest/config";

export default defineConfig({
  // The desktop app's React views (.tsx) use the automatic JSX runtime, as in tsconfig.renderer.json.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
  },
});
