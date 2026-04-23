import { defineConfig } from "vitest/config";

// Root config — owns coverage settings. Per-package configs own
// include/exclude/testTimeout. The workspace file (vitest.workspace.ts) wires
// them together when running from the repo root.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Skip vendored / generated / test-only code.
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/*.config.ts",
        "**/*.config.js",
        "**/*.test.ts",
        "**/test/**",
        "**/coverage/**",
        "packages/llm/src/providers/**",
        "packages/runner/src/**",
        "packages/dashboard/src/main.tsx",
        "packages/dashboard/src/App.tsx",
        "packages/dashboard/src/views/**",
        "packages/client-cli/src/cli.ts",
        "packages/gateway/src/bin.ts",
        "packages/channel-discord/src/standalone.ts",
        "packages/channel-discord/src/bot.ts",
      ],
      thresholds: {
        lines: 55,
        functions: 55,
        branches: 65,
        statements: 55,
      },
    },
  },
});
