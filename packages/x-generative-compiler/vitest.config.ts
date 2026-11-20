import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the compiler to this package's source so the Next, Vite, and Metro
// entrypoints exercise the same compile.ts the tests import directly.
export default defineConfig({
  resolve: {
    alias: {
      "@assistant-ui/x-generative-compiler": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
