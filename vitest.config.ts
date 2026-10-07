import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://nativos:local_only@127.0.0.1:55432/nativos_test",
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
