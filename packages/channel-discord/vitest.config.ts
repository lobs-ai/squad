import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "channel-discord",
    include: ["src/**/*.test.ts"],
  },
});
