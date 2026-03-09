import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  server: {
    port: parseInt(process.env.VITE_CLIENT_PORT ?? "5173", 10),
  },
  resolve: {
    alias: {
      "@fishbowl/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
});
