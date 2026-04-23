// Vitest workspace — runs every package's test suite from the repo root
// so `pnpm test:coverage` can merge coverage across packages.
//
// Per-package `vitest run` continues to work unchanged (each package has its
// own `vitest.config.ts` or falls back to defaults).
export default [
  "packages/protocol",
  "packages/llm",
  "packages/tools",
  "packages/runner",
  "packages/plugin-sdk",
  "packages/channel-sdk",
  "packages/channel-discord",
  "packages/client-cli",
  "packages/gateway",
  "packages/dashboard",
];
