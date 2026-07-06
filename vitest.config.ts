import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // girdwood.test.ts attaches to the published lake over HTTPS, and the
    // merge test runs real DuckDB merges — both can outrun the 5s default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
