import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: { DATA_DIR: "/tmp/specharvest-test-unused" },
  },
});
