import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "plugin-sdk",
    include: ["src/**/*.test.ts"],
  },
});
