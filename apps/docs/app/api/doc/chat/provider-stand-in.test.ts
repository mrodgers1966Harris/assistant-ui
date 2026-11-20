/**
 * Speaks the chat-completions stream that `@ai-sdk/openai` 3.0.71 parses in
 * `doStream` (`openaiChatChunkSchema` plus SSE `data:` frames). Tool calls are
 * returned only when the route offered that tool. File bytes are never invented
 * here; they have to come back from the route's own tool execute.
 */

const SERVER_KEY_PLACEHOLDER = "placeholder-not-a-real-key";

export const SNAPSHOT_RELATIVE_PATH = "internal/build-snapshot-marker.txt";
export const SNAPSHOT_MARKER = "SNAPSHOT_ONLY_MARKER_7c1e";
export const CALLER_CONTEXT_MARKER = "ZZCALLERCTX";

const REPO_TOOL_NAMES = new Set([
  "readFile",
  "bash",
  "readSourceMapFile",
  "inspectSourceMap",
]);

export type ProviderCall = {
  url: string;
  usedServerKey: boolean;
  body: unknown;
};

type StandInMode =
  | { kind: "text" }
  | { kind: "read-snapshot"; toolName: "readFile" | "readSourceMapFile" }
  | { kind: "bash-snapshot"; toolName: "bash" | "inspectSourceMap" }
  | { kind: "loop-bash"; toolName: "bash" | "inspectSourceMap" };

export function installProviderStandIn(mode: StandInMode): {
  calls: ProviderCall[];
  restore: () => void;
} {
  const calls: ProviderCall[] = [];
  const previous = globalThis.fetch;
  let toolRound = 0;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headerSource = new Headers(init?.headers);
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        if (!headerSource.has(key)) headerSource.set(key, value);
      });
    }
    const authorization = headerSource.get("authorization");
    const rawBody =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "";
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    calls.push({
      url,
      usedServerKey: authorization === `Bearer ${SERVER_KEY_PLACEHOLDER}`,
      body,
    });

    if (!url.includes("/chat/completions")) {
      return new Response("unexpected provider url", { status: 404 });
    }

    const offered = offeredToolNames(body);
    const toolCall = nextToolCall(mode, offered, toolRound);
    if (toolCall) {
      toolRound += 1;
      return sseResponse(
        toolCallChunks(toolCall.id, toolCall.name, toolCall.args),
      );
    }
    return sseResponse(textChunks("done"));
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

function offeredToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!body || typeof body !== "object") return names;
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function nextToolCall(
  mode: StandInMode,
  offered: Set<string>,
  toolRound: number,
): { id: string; name: string; args: Record<string, string> } | null {
  if (mode.kind === "text") return null;
  if (!offered.has(mode.toolName) || !REPO_TOOL_NAMES.has(mode.toolName)) {
    return null;
  }
  if (mode.kind === "loop-bash" && toolRound >= 6) return null;
  if (mode.kind !== "loop-bash" && toolRound >= 1) return null;

  if (mode.kind === "read-snapshot") {
    return {
      id: `read_${toolRound}`,
      name: mode.toolName,
      args: { path: SNAPSHOT_RELATIVE_PATH },
    };
  }

  const command =
    mode.kind === "loop-bash" ? "echo tick" : `cat ${SNAPSHOT_RELATIVE_PATH}`;
  return {
    id: `bash_${toolRound}`,
    name: mode.toolName,
    args: { command },
  };
}

function textChunks(content: string) {
  return [
    {
      id: "chatcmpl-test",
      model: "gpt-5.4-nano",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
        },
      ],
    },
    {
      id: "chatcmpl-test",
      model: "gpt-5.4-nano",
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

function toolCallChunks(
  id: string,
  name: string,
  args: Record<string, string>,
) {
  return [
    {
      id: "chatcmpl-test",
      model: "gpt-5.4-nano",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-test",
      model: "gpt-5.4-nano",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

function sseResponse(chunks: unknown[]) {
  const payload = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(`${payload}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function providerPromptText(calls: readonly ProviderCall[]): string {
  return calls
    .map((call) => {
      try {
        return JSON.stringify(call.body);
      } catch {
        return "";
      }
    })
    .join("\n");
}

const REJECTION_STATUSES = new Set([400, 401, 403, 413, 422]);

export function assertCallerContextNotBilled(
  calls: readonly ProviderCall[],
  status: number,
) {
  if (calls.length === 0) {
    if (!REJECTION_STATUSES.has(status)) {
      throw new Error(
        `caller page context was not billed, but the route returned ${status} instead of rejecting the request`,
      );
    }
    return;
  }
  const prompt = providerPromptText(calls);
  if (prompt.includes(CALLER_CONTEXT_MARKER)) {
    throw new Error(
      `unauthenticated request billed the server provider (calls=${calls.length}, serverKey=${calls.every((call) => call.usedServerKey)}, status=${status}, promptChars=${prompt.length})`,
    );
  }
}

export function assertSnapshotNotDisclosed(
  calls: readonly ProviderCall[],
  status: number,
  responseBody: string,
) {
  if (responseBody.includes(SNAPSHOT_MARKER)) {
    throw new Error(
      `unauthenticated response included source-snapshot contents (status=${status}, calls=${calls.length})`,
    );
  }
  if (calls.length === 0 && !REJECTION_STATUSES.has(status)) {
    throw new Error(
      `snapshot was not returned, but the route returned ${status} instead of rejecting the request`,
    );
  }
}

export function assertNoRepeatedRepoSteps(
  calls: readonly ProviderCall[],
  status: number,
) {
  if (calls.length === 0) {
    if (!REJECTION_STATUSES.has(status)) {
      throw new Error(
        `no provider call was made, but the route returned ${status} instead of rejecting the request`,
      );
    }
    return;
  }
  if (calls.length > 1) {
    throw new Error(
      `unauthenticated request drove ${calls.length} provider round trips (serverKey=${calls.every((call) => call.usedServerKey)}, status=${status})`,
    );
  }
}
