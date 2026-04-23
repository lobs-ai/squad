import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "dashboard",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
  },
});
