import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const docsRoot = fileURLToPath(new URL(".", import.meta.url));
const reactAiSdkEntry = fileURLToPath(
  new URL(
    "./app/api/doc/chat/react-ai-sdk-test-entry.test.ts",
    import.meta.url,
  ),
);

export default defineConfig({
  root: docsRoot,
  resolve: {
    alias: {
      "@": docsRoot,
      "@assistant-ui/react-ai-sdk": reactAiSdkEntry,
    },
  },
  test: {
    environment: "node",
    include: ["app/api/doc/chat/unauthenticated-assistant.security.test.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "development",
      OPENAI_API_KEY: "placeholder-not-a-real-key",
      OPENAI_BASE_URL: "http://provider.invalid/v1",
      NEXT_PUBLIC_AUI_AI_PLAYGROUND_ENABLED: "1",
    },
  },
});
