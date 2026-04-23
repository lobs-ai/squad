import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "channel-sdk",
    include: ["src/**/*.test.ts"],
  },
});
