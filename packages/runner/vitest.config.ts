import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runner",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
