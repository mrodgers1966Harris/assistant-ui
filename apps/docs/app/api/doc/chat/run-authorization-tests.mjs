import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chatDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(chatDir, "../../../..");
const repoRoot = path.resolve(docsDir, "../..");
const require = createRequire(
  path.join(repoRoot, "packages/react/package.json"),
);
const vitestDir = path.dirname(require.resolve("vitest/package.json"));
const storeModules = path.dirname(vitestDir);
const docsModules = path.join(docsDir, "node_modules");

function link(name) {
  const target = path.join(storeModules, name);
  const dest = path.join(docsModules, name);
  if (!existsSync(target)) {
    throw new Error(`missing ${target}`);
  }
  if (!existsSync(dest)) symlinkSync(target, dest);
}

link("vitest");
link("vite");

const vitestBin = path.join(vitestDir, "dist/cli.js");
const config = path.join(docsDir, "vitest.authorization.config.test.ts");
const result = spawnSync(
  process.execPath,
  [vitestBin, "run", "--config", config],
  { cwd: docsDir, stdio: "inherit" },
);

process.exit(result.status ?? 1);
