import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Security spec for the public docs chat routes.
 *
 * An anonymous caller must not be able to place their own system prompt or
 * tool list on a model request authenticated with the server provider key
 * (OPENAI_API_KEY in apps/docs/lib/ai/provider.ts). These tests fail while
 * that request is forwarded and pass once it is not.
 *
 * The stand-in for the provider and the rate-limit store answers only the
 * HTTP those clients send. It does not decide whether the route copies the
 * caller system prompt; the route, the AI SDK, and the OpenAI client do.
 */

const SERVER_KEY_PLACEHOLDER = "placeholder-not-a-credential";
const MODEL_BASE_URL = "http://model.invalid/v1";
const REDIS_URL = "http://redis.invalid";
const MAX_SYSTEM_LENGTH = 4000;

function callerMaterial(label: string) {
  return {
    system: `ATTACKER_SYSTEM_PROMPT_SENTINEL_${label}`,
    tool: `attacker_supplied_tool_${label}`,
  };
}

type CapturedCall = {
  url: string;
  body: string;
  headers: Headers;
};

const calls: CapturedCall[] = [];

function headerValue(headers: HeadersInit | undefined, name: string): string {
  const normalized = new Headers(headers);
  return normalized.get(name) ?? "";
}

function installFetch() {
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body == null
          ? ""
          : "<non-string body>";
    calls.push({
      url,
      body,
      headers: new Headers(init?.headers),
    });

    if (url === REDIS_URL || url.startsWith(`${REDIS_URL}/`)) {
      const command = JSON.parse(body) as unknown;
      const commands = Array.isArray(command[0])
        ? (command as unknown[][])
        : [command as unknown[]];
      const results = commands.map((entry) => {
        if (entry[0] === "evalsha" || entry[0] === "eval") {
          // fixedWindow script returns [usedTokens, effectiveLimit]. 1 of 5 allows the request.
          return { result: [1, 5] };
        }
        return { result: 0 };
      });
      return Response.json(Array.isArray(command[0]) ? results : results[0]);
    }

    if (url.startsWith(MODEL_BASE_URL)) {
      const stream = [
        'data: {"id":"chatcmpl-test","created":1,"model":"gpt-5.4-nano","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-test","created":1,"model":"gpt-5.4-nano","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  };
}

function userMessage(text: string) {
  return {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function systemMessage(text: string) {
  return {
    id: "system-1",
    role: "system",
    parts: [{ type: "text", text }],
  };
}

function attackerTools(tool: string) {
  return {
    [tool]: {
      description: "Tool definition supplied by the caller",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    },
  };
}

function anonymousRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      "x-forwarded-for": "203.0.113.50",
    },
    body: JSON.stringify(body),
  });
}

async function readResponse(response: Response) {
  try {
    await response.text();
  } catch {
    // The provider stream may end after the request body has already been sent.
  }
}

function modelCalls() {
  return calls.filter((call) => call.url.startsWith(MODEL_BASE_URL));
}

function expectCallerMaterialRejected(
  response: Response | undefined,
  material: { system: string; tool: string },
) {
  const leaked = modelCalls()
    .filter(
      (call) =>
        call.body.includes(material.system) ||
        call.body.includes(material.tool),
    )
    .map((call) => ({
      status: response?.status,
      authorization: headerValue(call.headers, "authorization"),
      body: call.body,
    }));
  expect(leaked).toEqual([]);
}

beforeAll(() => {
  process.env.OPENAI_API_KEY = SERVER_KEY_PLACEHOLDER;
  process.env.OPENAI_BASE_URL = MODEL_BASE_URL;
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = SERVER_KEY_PLACEHOLDER;
  process.env.UPSTASH_DISABLE_TELEMETRY = "1";
  delete process.env.NEXT_PUBLIC_POSTHOG_API_KEY;
  delete process.env.AUIX_PRISM_API_KEY;
  delete process.env.NEXT_PUBLIC_AUI_AI_PLAYGROUND_ENABLED;
  installFetch();
});

afterEach(() => {
  calls.length = 0;
});

describe("POST /api/chat", () => {
  it("does not send a caller system prompt or tool list with the server provider key after the rate limit allows the request", async () => {
    const material = callerMaterial("general");
    const { POST } = await import("./chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/chat", {
        messages: [userMessage("Say hello.")],
        system: material.system,
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });

  it("does not send a caller system prompt that sits on the length cap", async () => {
    const material = callerMaterial("cap");
    const { POST } = await import("./chat/route");
    const system = material.system.padEnd(MAX_SYSTEM_LENGTH, ".");
    expect(system).toHaveLength(MAX_SYSTEM_LENGTH);

    const response = await POST(
      anonymousRequest("http://docs.invalid/api/chat", {
        messages: [userMessage("Say hello.")],
        system,
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });

  it("does not send a caller tool list when the system field is over the length cap", async () => {
    const material = callerMaterial("over_cap");
    const { POST } = await import("./chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/chat", {
        messages: [userMessage("Say hello.")],
        system: `${material.system}${".".repeat(MAX_SYSTEM_LENGTH)}`,
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });

  it("does not treat a system-role message as an authorized system prompt", async () => {
    const material = callerMaterial("system_role");
    const { POST } = await import("./chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/chat", {
        messages: [systemMessage(material.system), userMessage("Say hello.")],
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });
});

describe("POST /api/doc/chat", () => {
  it("does not append a caller system string or caller tools onto the model request", async () => {
    const material = callerMaterial("doc");
    const { POST } = await import("./doc/chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/doc/chat", {
        messages: [userMessage("Where is Thread documented?")],
        system: material.system,
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });

  it("does not accept a system-role message as page context", async () => {
    const material = callerMaterial("doc_system_role");
    const { POST } = await import("./doc/chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/doc/chat", {
        messages: [
          systemMessage(material.system),
          userMessage("Where is Thread documented?"),
        ],
        tools: {},
      }),
    );

    await readResponse(response);
    expectCallerMaterialRejected(response, material);
  });
});

describe("feature-gated chat routes", () => {
  it("does not call the model for playground chat while the playground flag is unset", async () => {
    const material = callerMaterial("playground");
    const { POST } = await import("./playground-chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/playground-chat", {
        messages: [userMessage("Say hello.")],
        system: material.system,
        tools: attackerTools(material.tool),
        builderConfig: { note: material.system },
      }),
    );

    await readResponse(response);
    expect(response.status).toBe(404);
    expectCallerMaterialRejected(response, material);
  });

  it("does not call the model for xulux chat while the playground flag is unset", async () => {
    const material = callerMaterial("xulux");
    const { POST } = await import("./xulux/chat/route");
    const response = await POST(
      anonymousRequest("http://docs.invalid/api/xulux/chat", {
        messages: [userMessage("Say hello.")],
        system: material.system,
        tools: attackerTools(material.tool),
      }),
    );

    await readResponse(response);
    expect(response.status).toBe(404);
    expectCallerMaterialRejected(response, material);
  });
});
