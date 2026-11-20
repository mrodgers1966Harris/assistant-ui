import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Spec for the chat route the assistant-ui skill tells a coding agent to write
 * (`packages/cli/plugin/skills/assistant-ui/SKILL.md`, "Create a chat API route").
 *
 * The route must import only `ai` and `@ai-sdk/openai`. It must treat a request
 * as authenticated only when the header `x-assistant-ui-session` is exactly
 * `app-session`, and it must return 401 or 403 without calling the model
 * otherwise. The check has to gate the model call: a provider request that
 * starts before the refusal is a failure.
 *
 * For an authenticated request the route may forward the top-level message
 * list, a top-level system string, and top-level frontend tool schemas. It
 * must not spread the JSON body, or a nested `config` object, into the model
 * call. Output limits, temperature, headers, provider options, a replacement
 * message list, and tools nested under `config` must not reach the provider.
 */
const SESSION_HEADER = "x-assistant-ui-session";
const SESSION_VALUE = "app-session";
const LEGITIMATE_USER_TEXT = "hello from the user";
const SKILL_PATH = path.resolve(
  import.meta.dirname,
  "../../plugin/skills/assistant-ui/SKILL.md",
);
const HARNESS_PATH = path.resolve(
  import.meta.dirname,
  "chat-route-harness.mjs",
);
const DOCS_PACKAGE_JSON = path.resolve(
  import.meta.dirname,
  "../../../../apps/docs/package.json",
);

const attackBody = {
  messages: [{ role: "user", content: LEGITIMATE_USER_TEXT }],
  system: "LEGITIMATE-SYSTEM",
  maxOutputTokens: 999_999,
  temperature: 0.02,
  headers: {
    authorization: "Bearer attacker-supplied",
    "x-injected": "top-level",
  },
  providerOptions: {
    openai: {
      instructions: "ATTACKER-TOP-INSTRUCTIONS",
      reasoningEffort: "none",
      serviceTier: "flex",
    },
  },
  tools: {
    allowed_tool: { description: "ALLOWED-TOOL" },
  },
  config: {
    maxOutputTokens: 1_000_000,
    temperature: 0.01,
    messages: [
      { role: "system", content: "ATTACKER-SYSTEM-MESSAGE" },
      { role: "user", content: "ATTACKER-USER-MESSAGE" },
    ],
    system: "ATTACKER-SYSTEM-OPTION",
    headers: {
      authorization: "Bearer attacker-supplied",
      "x-injected": "from-config",
    },
    providerOptions: {
      openai: {
        instructions: "ATTACKER-INSTRUCTIONS",
        reasoningEffort: "none",
        serviceTier: "flex",
      },
    },
    tools: {
      exfiltrate: { description: "ATTACKER-TOOL" },
    },
  },
};

describe("assistant-ui skill chat route", () => {
  it("does not call the model for a request without a session", async () => {
    const result = await runSkillRoute({}, attackBody);

    expect(result.calls).toEqual([]);
    expect(result.thrown).toBeNull();
    expect([401, 403]).toContain(result.status);
  });

  it("does not call the model when the session header is a different value", async () => {
    const result = await runSkillRoute(
      { [SESSION_HEADER]: "other-session" },
      attackBody,
    );

    expect(result.calls).toEqual([]);
    expect(result.thrown).toBeNull();
    expect([401, 403]).toContain(result.status);
  });

  it("keeps an authenticated call on the route's message list and model settings", async () => {
    const result = await runSkillRoute(
      { [SESSION_HEADER]: SESSION_VALUE },
      attackBody,
    );

    expect(result.calls.length).toBeGreaterThan(0);
    const call = result.calls[0];
    const serialized = JSON.stringify(call);

    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(serialized).toContain(LEGITIMATE_USER_TEXT);
    expect(serialized).not.toContain("ATTACKER-USER-MESSAGE");
    expect(serialized).not.toContain("ATTACKER-SYSTEM-MESSAGE");
    expect(serialized).not.toContain("ATTACKER-SYSTEM-OPTION");
    expect(serialized).not.toContain("ATTACKER-INSTRUCTIONS");
    expect(serialized).not.toContain("ATTACKER-TOP-INSTRUCTIONS");
    expect(serialized).not.toContain("ATTACKER-TOOL");
    expect(serialized).not.toContain("Bearer attacker-supplied");
    expect(serialized).not.toContain("x-injected");
    expect(call.body?.max_output_tokens).not.toBe(1_000_000);
    expect(call.body?.max_output_tokens).not.toBe(999_999);
    expect(call.body?.temperature).not.toBe(0.01);
    expect(call.body?.temperature).not.toBe(0.02);
    expect(call.body?.service_tier).not.toBe("flex");
    expect(call.body?.model).toBe(modelIdFromSkill());
  });
});

function modelIdFromSkill(): string {
  const route = extractChatRoute(readFileSync(SKILL_PATH, "utf8"));
  const match = route.match(/openai\(\s*["']([^"']+)["']\s*\)/);
  if (!match?.[1]) {
    throw new Error("The skill chat route does not name an openai model id");
  }
  return match[1];
}

async function runSkillRoute(
  headers: Record<string, string>,
  body: unknown,
): Promise<{
  status: number | null;
  thrown: string | null;
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    body?: {
      model?: string;
      max_output_tokens?: number;
      temperature?: number;
      service_tier?: string;
    };
  }>;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "skill-chat-route-"));
  const routePath = path.join(directory, "route.ts");
  writeFileSync(routePath, materializeRoute(readFileSync(SKILL_PATH, "utf8")));

  const env = { ...process.env };
  // Placeholder only. The harness never lets the provider reach the network.
  env.OPENAI_API_KEY = "test-placeholder-not-a-credential";
  delete env.OPENAI_BASE_URL;

  const stdout = await spawnNode(
    [HARNESS_PATH, routePath],
    JSON.stringify({ headers, body }),
    env,
  );
  return JSON.parse(stdout);
}

function materializeRoute(skill: string): string {
  const route = extractChatRoute(skill);
  const aiUrl = resolvePackageEntry("ai");
  const openaiUrl = resolvePackageEntry("@ai-sdk/openai");
  return route
    .replaceAll(
      /from\s+["']@ai-sdk\/openai["']/g,
      `from ${JSON.stringify(openaiUrl)}`,
    )
    .replaceAll(/from\s+["']ai["']/g, `from ${JSON.stringify(aiUrl)}`);
}

function extractChatRoute(skill: string): string {
  const marker = "Create a chat API route";
  const markerAt = skill.indexOf(marker);
  if (markerAt < 0) {
    throw new Error(`Skill is missing the "${marker}" section`);
  }
  const fenceAt = skill.indexOf("```", markerAt);
  if (fenceAt < 0) throw new Error("Skill chat route sample is missing");
  const languageLineEnd = skill.indexOf("\n", fenceAt);
  const closeAt = skill.indexOf("```", languageLineEnd + 1);
  if (closeAt < 0) throw new Error("Skill chat route sample is not closed");
  return skill.slice(languageLineEnd + 1, closeAt);
}

function resolvePackageEntry(name: string): string {
  const require = createRequire(DOCS_PACKAGE_JSON);
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: { "."?: string | { import?: string } };
  };
  const entry = packageJson.exports?.["."];
  const relative = typeof entry === "string" ? entry : entry?.import;
  if (!relative) {
    throw new Error(`No ESM entry for ${name}`);
  }
  return pathToFileURL(path.join(path.dirname(packageJsonPath), relative)).href;
}

function spawnNode(
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", ...args],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`route harness exited ${code}\n${err}\n${out}`));
        return;
      }
      resolve(out);
    });
    child.stdin.end(stdin);
  });
}
