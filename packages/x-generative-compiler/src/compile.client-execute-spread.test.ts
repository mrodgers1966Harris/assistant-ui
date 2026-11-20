import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  toolResultStream,
  unstable_runPendingTools,
} from "../../assistant-stream/src/core/tool/toolResultStream";
import type { AssistantMessage } from "../../assistant-stream/src/core/utils/types";
import {
  compileGenerative,
  GenerativeCompileError,
  type CompileOptions,
} from "./compile";

const NEXT_LOADER = new URL("../../next/src/loader.ts", import.meta.url).href;
const VITE_PLUGIN = new URL("../../vite/src/index.ts", import.meta.url).href;
const METRO_INDEX = new URL("../../metro/src/index.ts", import.meta.url).href;
const METRO_TRANSFORMER = new URL(
  "../../metro/src/transformer.ts",
  import.meta.url,
).href;

/** Placeholder returned by a server execute that must not reach the client. */
const SERVER_EXECUTE_RESULT = "server-execute-body";
/** Placeholder returned by a client render that must not reach the server. */
const CLIENT_RENDER_RESULT = "client-render-body";
/** Placeholder returned by a client renderText that must not reach the server. */
const CLIENT_RENDER_TEXT_RESULT = "client-render-text-body";
/** Placeholder invoked by a streamCall that an external tool must not keep. */
const SERVER_STREAM_CALL_RESULT = "server-stream-call-body";

const SHARED_EXECUTE = `const shared = { execute: async () => "${SERVER_EXECUTE_RESULT}" };`;

type Emitted = string | undefined;

function compileOrReject(source: string, options: CompileOptions): Emitted {
  try {
    return compileGenerative(source, options).code;
  } catch (error) {
    if (error instanceof GenerativeCompileError) return undefined;
    throw error;
  }
}

function toolkitSource(toolBody: string, prelude = SHARED_EXECUTE): string {
  return `"use generative";
import { defineToolkit } from "@assistant-ui/react";
${prelude}
export default defineToolkit({
  weather: {
${toolBody}
  },
});
`;
}

function directiveSource(
  toolBody: string,
  markers: string,
  prelude = SHARED_EXECUTE,
): string {
  return `"use generative";
import { defineToolkit, ${markers} } from "@assistant-ui/react";
${prelude}
export default defineToolkit({
  weather: {
${toolBody}
  },
});
`;
}

const nextOptions = (target: CompileOptions["target"]): CompileOptions => ({
  target,
  filename: "/app/toolkit.tsx",
  sourceMaps: false,
});

const viteOptions = (target: CompileOptions["target"]): CompileOptions => ({
  target,
  filename: "/app/toolkit.tsx",
  sourceMaps: true,
  injectServerOnly: false,
});

const metroOptions = (target: CompileOptions["target"]): CompileOptions => ({
  target,
  filename: "/app/toolkit.tsx",
  injectServerOnly: false,
});

async function loadModule(code: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "aui-generative-leak-"));
  const file = nodePath.join(dir, "toolkit.mjs");
  // `server-only` is the compiler's server guard. The tool object does not
  // depend on it, and this package does not install that module.
  writeFileSync(file, code.replaceAll('import "server-only";\n', ""));
  return import(pathToFileURL(file).href);
}

function pendingMessage(toolName: string): AssistantMessage {
  return {
    role: "assistant",
    status: { type: "requires-action", reason: "tool-calls" },
    parts: [
      {
        type: "tool-call",
        state: "call",
        status: { type: "running", isArgsComplete: true },
        toolCallId: "call-1",
        toolName,
        argsText: "{}",
        args: {},
      },
    ],
    content: [
      {
        type: "tool-call",
        state: "call",
        status: { type: "running", isArgsComplete: true },
        toolCallId: "call-1",
        toolName,
        argsText: "{}",
        args: {},
      },
    ],
    metadata: {
      unstable_state: {},
      unstable_data: [],
      unstable_annotations: [],
      steps: [],
      custom: {},
    },
  };
}

async function pendingToolsRan(
  tools: Record<string, unknown>,
  toolName: string,
  marker: string,
): Promise<boolean> {
  const updated = await unstable_runPendingTools(
    pendingMessage(toolName),
    tools as never,
    new AbortController().signal,
    async () => {
      throw new Error("human input is not used by this fixture");
    },
  );
  return updated.parts.some(
    (part) =>
      part.type === "tool-call" && "result" in part && part.result === marker,
  );
}

/**
 * Drives `toolResultStream` — the transform installed by `ToolInvocationTracker`
 * and `useDataStreamRuntime` — with a finished tool call. The `meta` fields are
 * the shape `AssistantMetaTransformStream` writes onto those chunks before
 * `ToolExecutionStream` reads them.
 */
async function clientPipelineRan(
  tools: Record<string, unknown>,
  toolName: string,
  marker: string,
): Promise<boolean> {
  const meta = { type: "tool-call" as const, toolCallId: "call-1", toolName };
  const chunks = [
    {
      type: "part-start" as const,
      path: [] as number[],
      part: { type: "tool-call" as const, toolCallId: "call-1", toolName },
    },
    { type: "text-delta" as const, path: [0], textDelta: "{}", meta },
    { type: "tool-call-args-text-finish" as const, path: [0], meta },
  ];
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const results: unknown[] = [];
  await input
    .pipeThrough(
      toolResultStream(
        tools as never,
        new AbortController().signal,
        async () => {
          throw new Error("human input is not used by this fixture");
        },
      ),
    )
    .pipeTo(
      new WritableStream({
        write(chunk) {
          if (chunk.type === "result") results.push(chunk.result);
        },
      }),
    );
  return results.includes(marker);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectClientOmitsServerExecute(
  source: string,
  options: CompileOptions,
): Promise<void> {
  const code = compileOrReject(source, options);
  if (code === undefined) return;

  const leakedInSource =
    code.includes(SERVER_EXECUTE_RESULT) ||
    code.includes(SERVER_STREAM_CALL_RESULT);
  let ranViaPendingTools = false;
  let ranViaClientPipeline = false;
  let loadError: string | undefined;
  try {
    const loaded = await withTimeout(loadModule(code), 1000, "load module");
    const tools = loaded.default as Record<string, unknown>;
    ranViaPendingTools = await withTimeout(
      pendingToolsRan(tools, "weather", SERVER_EXECUTE_RESULT),
      1000,
      "pending tools",
    );
    ranViaClientPipeline = await withTimeout(
      clientPipelineRan(tools, "weather", SERVER_EXECUTE_RESULT),
      1000,
      "client pipeline",
    );
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  expect({
    leakedInSource,
    ranViaPendingTools,
    ranViaClientPipeline,
    loadError,
  }).toEqual({
    leakedInSource: false,
    ranViaPendingTools: false,
    ranViaClientPipeline: false,
    loadError: undefined,
  });
}

async function compileThroughVite(
  source: string,
  consumer: "client" | "server",
): Promise<Emitted> {
  const vite = (await import(VITE_PLUGIN)) as {
    aui: () => Array<{
      name?: string;
      transform?: (
        this: { environment: { config: { consumer: "client" | "server" } } },
        code: string,
        id: string,
      ) => { code: string } | undefined;
    }>;
  };
  const plugin = vite
    .aui()
    .find((entry) => entry.name === "assistant-ui:use-generative");
  if (!plugin?.transform) {
    throw new Error("vite generative plugin is missing");
  }
  try {
    return plugin.transform.call(
      { environment: { config: { consumer } } },
      source,
      "/app/toolkit.tsx",
    )?.code;
  } catch (error) {
    if (error instanceof GenerativeCompileError) return undefined;
    throw error;
  }
}

function compileThroughNext(
  source: string,
  target: "client" | "server",
): Promise<Emitted> {
  const context = {
    resourcePath: "/app/toolkit.tsx",
    resourceQuery: `?generative-env=${target}`,
    sourceMap: false,
    async() {
      return (error: unknown, code?: string) => {
        if (error instanceof GenerativeCompileError) {
          finish(undefined);
          return;
        }
        if (error) {
          fail(error);
          return;
        }
        finish(code);
      };
    },
  };
  let finish!: (code: Emitted) => void;
  let fail!: (error: unknown) => void;
  const result = new Promise<Emitted>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return (async () => {
    const loaderModule = (await import(NEXT_LOADER)) as {
      default: (this: typeof context, source: string) => void;
    };
    try {
      loaderModule.default.call(context, source);
    } catch (error) {
      if (error instanceof GenerativeCompileError) return undefined;
      throw error;
    }
    return result;
  })();
}

async function compileThroughMetro(
  source: string,
  environment: string | undefined,
): Promise<Emitted> {
  const metroIndex = (await import(METRO_INDEX)) as {
    UPSTREAM_TRANSFORMER_ENV: string;
  };
  process.env[metroIndex.UPSTREAM_TRANSFORMER_ENV] = nodePath.join(
    fileFromMeta(
      import.meta.url,
      "../../metro/src/__fixtures__/mock-upstream.cjs",
    ),
  );
  const transformer = (await import(METRO_TRANSFORMER)) as {
    transform: (props: {
      filename: string;
      src: string;
      options?: { customTransformOptions?: { environment?: string } };
    }) => { src?: string };
  };
  const { transform } = transformer;
  try {
    const out = transform({
      filename: "/app/toolkit.tsx",
      src: source,
      options:
        environment === undefined
          ? {}
          : { customTransformOptions: { environment } },
    }) as { src?: string };
    return out.src;
  } catch (error) {
    if (error instanceof GenerativeCompileError) return undefined;
    throw error;
  }
}

function fileFromMeta(metaUrl: string, relative: string): string {
  return nodePath.join(nodePath.dirname(new URL(metaUrl).pathname), relative);
}

async function expectEmittedOmits(
  code: Emitted,
  marker: string,
): Promise<void> {
  if (code === undefined) return;
  expect(code).not.toContain(marker);
  const loaded = await loadModule(code);
  const weather = (
    loaded.default as {
      weather?: {
        render?: (props: unknown) => unknown;
        execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
      };
    }
  ).weather;
  if (weather?.render) {
    expect(weather.render({})).not.toBe(marker);
  }
  if (weather?.execute) {
    const result = await weather.execute(
      {},
      {
        toolCallId: "call-1",
        abortSignal: new AbortController().signal,
        human: async () => {
          throw new Error("human input is not used by this fixture");
        },
      },
    );
    expect(result).not.toBe(marker);
  }
}

describe("client build must not keep a server execute hidden in a tool object", () => {
  const shapes: Array<[string, string]> = [
    [
      "object spread after a static backend execute",
      toolkitSource(`    description: "weather",
    execute: async () => 1,
    render: () => null,
    ...shared,`),
    ],
    [
      "object spread before a static backend execute",
      toolkitSource(`    description: "weather",
    ...shared,
    execute: async () => 1,
    render: () => null,`),
    ],
    [
      "inline object spread after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    ...{ execute: async () => "${SERVER_EXECUTE_RESULT}" },`,
        "",
      ),
    ],
    [
      "conditional spread after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    ...(true ? { execute: async () => "${SERVER_EXECUTE_RESULT}" } : {}),`,
        "",
      ),
    ],
    [
      "spread of a call after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    ...hidden(),`,
        `const hidden = () => ({ execute: async () => "${SERVER_EXECUTE_RESULT}" });`,
      ),
    ],
    [
      "computed identifier key after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    [executeKey]: serverExecute,`,
        `const executeKey = "execute";
const serverExecute = async () => "${SERVER_EXECUTE_RESULT}";`,
      ),
    ],
    [
      "computed expression key after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    ["exec" + "ute"]: async () => "${SERVER_EXECUTE_RESULT}",`,
        "",
      ),
    ],
    [
      "computed string key after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    ["execute"]: async () => "${SERVER_EXECUTE_RESULT}",`,
        "",
      ),
    ],
    [
      "computed method after a static execute",
      toolkitSource(
        `    execute: async () => 1,
    render: () => null,
    [executeKey]() { return "${SERVER_EXECUTE_RESULT}"; },`,
        `const executeKey = "execute";`,
      ),
    ],
    [
      "object spread after a frontend execute",
      toolkitSource(`    execute: async () => { "use client"; return "client-execute-body"; },
    render: () => null,
    ...shared,`),
    ],
    [
      "object spread before a frontend execute",
      toolkitSource(`    ...shared,
    execute: async () => { "use client"; return "client-execute-body"; },
    render: () => null,`),
    ],
    [
      "object spread after an execute method",
      toolkitSource(`    execute() { return 1; },
    render: () => null,
    ...shared,`),
    ],
    [
      "object spread after humanTool()",
      directiveSource(
        `    execute: humanTool(),
    render: () => null,
    ...shared,`,
        "humanTool",
      ),
    ],
    [
      "object spread after stubTool()",
      directiveSource(
        `    execute: stubTool(),
    render: () => null,
    ...shared,`,
        "stubTool",
      ),
    ],
    [
      "object spread after externalTool()",
      directiveSource(
        `    execute: externalTool(),
    render: () => null,
    ...{
      execute: async () => "${SERVER_EXECUTE_RESULT}",
      streamCall() { return "${SERVER_STREAM_CALL_RESULT}"; },
    },`,
        "externalTool",
        "",
      ),
    ],
    [
      "object spread after providerTool()",
      directiveSource(
        `    execute: providerTool({ providerId: "demo" }),
    render: () => null,
    ...shared,`,
        "providerTool",
      ),
    ],
  ];

  it.each(shapes)(
    "compileGenerative client target: %s",
    async (_name, source) => {
      await expectClientOmitsServerExecute(source, nextOptions("client"));
      await expectClientOmitsServerExecute(source, viteOptions("client"));
      await expectClientOmitsServerExecute(source, metroOptions("client"));
    },
  );

  const spreadAfter = shapes[0]![1];
  const computedKey = shapes[5]![1];

  it("next loader client target omits a spread server execute", async () => {
    const code = await compileThroughNext(spreadAfter, "client");
    await expectClientOmitsServerExecuteFromCode(code);
  });

  it("vite plugin client target omits a spread server execute", async () => {
    const code = await compileThroughVite(spreadAfter, "client");
    await expectClientOmitsServerExecuteFromCode(code);
  });

  it("metro transformer client target omits a spread server execute", async () => {
    const code = await compileThroughMetro(spreadAfter, undefined);
    await expectClientOmitsServerExecuteFromCode(code);
  });

  it("next loader client target omits a computed execute key", async () => {
    const code = await compileThroughNext(computedKey, "client");
    await expectClientOmitsServerExecuteFromCode(code);
  });

  it("vite plugin client target omits a computed execute key", async () => {
    const code = await compileThroughVite(computedKey, "client");
    await expectClientOmitsServerExecuteFromCode(code);
  });

  it("metro transformer client target omits a computed execute key", async () => {
    const code = await compileThroughMetro(computedKey, undefined);
    await expectClientOmitsServerExecuteFromCode(code);
  });
});

async function expectClientOmitsServerExecuteFromCode(
  code: Emitted,
): Promise<void> {
  if (code === undefined) return;
  const leakedInSource =
    code.includes(SERVER_EXECUTE_RESULT) ||
    code.includes(SERVER_STREAM_CALL_RESULT);
  let ranViaPendingTools = false;
  let ranViaClientPipeline = false;
  const loaded = await loadModule(code);
  const tools = loaded.default as Record<string, unknown>;
  ranViaPendingTools = await pendingToolsRan(
    tools,
    "weather",
    SERVER_EXECUTE_RESULT,
  );
  ranViaClientPipeline = await clientPipelineRan(
    tools,
    "weather",
    SERVER_EXECUTE_RESULT,
  );
  expect({ leakedInSource, ranViaPendingTools, ranViaClientPipeline }).toEqual({
    leakedInSource: false,
    ranViaPendingTools: false,
    ranViaClientPipeline: false,
  });
}

describe("server build must not keep a client render hidden behind a spread or computed key", () => {
  const toolRenderSpread = toolkitSource(
    `    execute: async () => 1,
    render: () => null,
    ...{ render: () => "${CLIENT_RENDER_RESULT}" },`,
    "",
  );
  const toolRenderComputed = toolkitSource(
    `    execute: async () => 1,
    render: () => null,
    ["render"]: () => "${CLIENT_RENDER_RESULT}",`,
    "",
  );
  const toolRenderTextSpread = toolkitSource(
    `    execute: async () => 1,
    renderText: { complete: () => "static-render-text" },
    ...{ renderText: { complete: () => "${CLIENT_RENDER_TEXT_RESULT}" } },`,
    "",
  );

  const componentSource = `"use generative";
import { defineToolkit } from "@assistant-ui/react";
import { defineGenerativeComponents } from "@assistant-ui/react-generative-ui";
export const library = defineGenerativeComponents({
  Card: {
    description: "card",
    render: () => null,
    ...{ render: () => "${CLIENT_RENDER_RESULT}" },
    ["render"]: () => "${CLIENT_RENDER_RESULT}",
  },
  Badge: {
    description: "badge",
    ...{ render: () => "${CLIENT_RENDER_RESULT}" },
  },
});
export default defineToolkit({
  weather: {
    execute: async () => 1,
    render: () => null,
  },
});
`;

  it("drops a tool render reintroduced by a spread on the server", async () => {
    for (const options of [
      nextOptions("server"),
      viteOptions("server"),
      metroOptions("server"),
    ]) {
      await expectEmittedOmits(
        compileOrReject(toolRenderSpread, options),
        CLIENT_RENDER_RESULT,
      );
    }
    await expectEmittedOmits(
      await compileThroughNext(toolRenderSpread, "server"),
      CLIENT_RENDER_RESULT,
    );
    await expectEmittedOmits(
      await compileThroughVite(toolRenderSpread, "server"),
      CLIENT_RENDER_RESULT,
    );
    await expectEmittedOmits(
      await compileThroughMetro(toolRenderSpread, "node"),
      CLIENT_RENDER_RESULT,
    );
  });

  it("drops a tool render reintroduced by a computed key on the server", async () => {
    await expectEmittedOmits(
      compileOrReject(toolRenderComputed, nextOptions("server")),
      CLIENT_RENDER_RESULT,
    );
  });

  it("drops a tool renderText reintroduced by a spread on the server", async () => {
    const code = compileOrReject(toolRenderTextSpread, nextOptions("server"));
    if (code === undefined) return;
    expect(code).not.toContain(CLIENT_RENDER_TEXT_RESULT);
    const loaded = await loadModule(code);
    const renderText = (
      loaded.default as {
        weather?: { renderText?: { complete?: () => string } };
      }
    ).weather?.renderText;
    if (renderText?.complete) {
      expect(renderText.complete()).not.toBe(CLIENT_RENDER_TEXT_RESULT);
    }
  });

  it("drops a component render reintroduced by a spread or computed key on the server", async () => {
    const code = compileOrReject(componentSource, nextOptions("server"));
    if (code === undefined) return;
    expect(code).not.toContain(CLIENT_RENDER_RESULT);
    const loaded = await loadModule(code);
    const library = loaded.library as {
      Card?: { render?: () => string };
      Badge?: { render?: () => string };
    };
    if (library?.Card?.render) {
      expect(library.Card.render()).not.toBe(CLIENT_RENDER_RESULT);
    }
    if (library?.Badge?.render) {
      expect(library.Badge.render()).not.toBe(CLIENT_RENDER_RESULT);
    }
  });
});

describe("external tool metadata that the client strip removes by static name", () => {
  const source = directiveSource(
    `    execute: externalTool(),
    description: "static description",
    parameters: { type: "object", properties: {} },
    render: () => null,
    ...{
      description: "spread-description-body",
      parameters: { type: "object", properties: { spread: { type: "string" } } },
      streamCall() { return "${SERVER_STREAM_CALL_RESULT}"; },
      execute: async () => "${SERVER_EXECUTE_RESULT}",
    },`,
    "externalTool",
    "",
  );

  it("does not keep spread description, parameters, streamCall, or execute", async () => {
    const code = compileOrReject(source, nextOptions("client"));
    if (code === undefined) return;
    expect(code).not.toContain("spread-description-body");
    expect(code).not.toContain(SERVER_STREAM_CALL_RESULT);
    expect(code).not.toContain(SERVER_EXECUTE_RESULT);
    const loaded = await loadModule(code);
    const weather = (
      loaded.default as {
        weather?: {
          description?: string;
          execute?: () => Promise<string>;
          streamCall?: () => string;
        };
      }
    ).weather;
    expect(weather?.description).not.toBe("spread-description-body");
    if (weather?.execute) {
      expect(await weather.execute()).not.toBe(SERVER_EXECUTE_RESULT);
    }
    if (weather?.streamCall) {
      expect(weather.streamCall()).not.toBe(SERVER_STREAM_CALL_RESULT);
    }
  });
});

beforeAll(async () => {
  const metroIndex = (await import(METRO_INDEX)) as {
    UPSTREAM_TRANSFORMER_ENV: string;
  };
  process.env[metroIndex.UPSTREAM_TRANSFORMER_ENV] = nodePath.join(
    fileFromMeta(
      import.meta.url,
      "../../metro/src/__fixtures__/mock-upstream.cjs",
    ),
  );
});
