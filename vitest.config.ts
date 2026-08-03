import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "worker/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 10000
  }
});
