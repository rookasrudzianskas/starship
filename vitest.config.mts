import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Performance assertions need an uncontended worker; keep their limits unchanged.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
