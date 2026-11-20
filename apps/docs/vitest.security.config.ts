import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compileGenerative,
  isGenerativeModule,
} from "../../packages/x-generative-compiler/dist/index.js";

const docsRoot = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pnpmDir = fileURLToPath(
  new URL("../../node_modules/.pnpm/", import.meta.url),
);
const nextDir = readdirSync(pnpmDir).find((name) => name.startsWith("next@"));
if (!nextDir) {
  throw new Error(
    "next is not installed; cannot resolve the server-only marker",
  );
}
const serverOnlyEmpty = fileURLToPath(
  new URL(
    `../../node_modules/.pnpm/${nextDir}/node_modules/next/dist/compiled/server-only/empty.js`,
    import.meta.url,
  ),
);

/**
 * The docs app compiles `"use generative"` modules with the same compiler the
 * Next loader runs for the server build (`@assistant-ui/next` loader, target
 * `server`). Route tests load that server build, not the authoring source.
 */
function generativeServerPlugin() {
  return {
    name: "generative-server",
    enforce: "pre" as const,
    load(id: string) {
      const filename = id.split("?")[0] ?? id;
      if (filename.endsWith(".mdx")) {
        return "export const frontmatter = { title: 'page' };\nexport default function Page() { return null; }\n";
      }
      if (filename.endsWith(".json") && id.includes("?")) {
        return `export default ${readFileSync(filename, "utf8")};\n`;
      }
      return null;
    },
    transform(code: string, id: string) {
      const filename = id.split("?")[0] ?? id;
      if (!filename.startsWith(docsRoot) || !isGenerativeModule(code)) {
        return null;
      }
      return compileGenerative(code, {
        target: "server",
        filename,
        sourceMaps: true,
      });
    },
  };
}

export default {
  plugins: [generativeServerPlugin()],
  test: {
    environment: "node",
    include: ["app/api/**/*.security.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyEmpty },
      {
        find: "@/lib/utils",
        replacement: `${repoRoot}packages/ui/src/lib/utils.ts`,
      },
      {
        find: "@/components/ui",
        replacement: `${repoRoot}packages/ui/src/components/ui`,
      },
      {
        find: "@/components/assistant-ui",
        replacement: `${repoRoot}packages/ui/src/components/assistant-ui`,
      },
      {
        find: /^@\//,
        replacement: `${docsRoot}`,
      },
      {
        find: "fumadocs-mdx:collections/server",
        replacement: `${docsRoot}.source/server.ts`,
      },
    ],
  },
};
