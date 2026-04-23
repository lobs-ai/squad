import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "client-cli",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15000,
  },
});
