import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The merge test runs real DuckDB merges, which can outrun the 5s default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
