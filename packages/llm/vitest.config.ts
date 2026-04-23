import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "llm",
    include: ["src/**/*.test.ts"],
  },
});
