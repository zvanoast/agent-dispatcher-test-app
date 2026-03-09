import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fishbowl/shared": new URL("../shared/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
