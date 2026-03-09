import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@fishbowl/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
});
