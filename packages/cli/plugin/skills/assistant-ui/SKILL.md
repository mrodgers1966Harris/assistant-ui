---
name: assistant-ui
description: Add, configure, and integrate assistant-ui components in React apps. Use when developers ask to add a chat thread, set up a runtime, integrate with AI SDK, configure tools, or build AI chat interfaces with assistant-ui.
---

# assistant-ui

Use this skill to help users build AI chat interfaces with assistant-ui.

## Step 1: Check Project Setup

Check if the project has `components.json` (shadcn config) and `@assistant-ui/react` installed.

If assistant-ui is not yet set up, run:

```bash
npx assistant-ui init --yes
```

This initializes shadcn and installs the default assistant-ui chat components.

## Step 2: Add Components

Install components via the shadcn registry:

```bash
npx shadcn@latest add "https://r.assistant-ui.com/chat/b/ai-sdk-quick-start/json"
```

Available component presets:

| Preset | Registry URL |
|--------|-------------|
| AI SDK Quick Start | `https://r.assistant-ui.com/chat/b/ai-sdk-quick-start/json` |

You can also add individual assistant-ui shadcn components:

```bash
npx shadcn@latest add assistant-ui/thread
npx shadcn@latest add assistant-ui/markdown-text
```

## Step 3: Runtime Setup

assistant-ui requires a runtime. The most common setup uses AI SDK:

### AI SDK Runtime (recommended)

Install the integration package:
```bash
npm install @assistant-ui/react-ai-sdk
```

Create a chat API route (Next.js App Router):

```ts
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export const maxDuration = 30;

// Placeholder session check. Replace it with the app's real auth (Auth.js,
// Clerk, Supabase, ...). It refuses every request in production builds.
async function getSession(req: Request) {
  if (process.env.NODE_ENV === "production") return null;
  const token = req.headers.get("x-assistant-ui-session");
  return token === "app-session" ? { userId: "dev-user" } : null;
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.messages)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Keep only the conversation turns; never forward other body fields.
  const messages = body.messages
    .filter(
      (message: { role?: unknown }) =>
        message?.role === "user" || message?.role === "assistant",
    )
    .map(({ role, content }: { role: "user" | "assistant"; content: any }) => ({
      role,
      content,
    }));

  const result = streamText({
    model: openai("gpt-5.4-nano"),
    system: "You are a helpful assistant.",
    messages,
    maxOutputTokens: 1024,
  });

  return result.toDataStreamResponse();
}
```

When writing this route:

- Replace `getSession` with the project's existing session check before the route is deployed. If the project has no auth, add it or tell the user the route must stay unreachable. Never call the model before the session check passes.
- Model settings (`model`, `system`, `maxOutputTokens`, `temperature`, `providerOptions`, `headers`, `tools`) are chosen on the server. Do not spread the request body or its `config` object into `streamText`. If the UI must pick a value, such as a model id from a model selector, read that one field and check it against a server-side allowlist.

Create the assistant component:

```tsx
"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Thread } from "@/components/assistant-ui/thread";

export const Assistant = () => {
  const runtime = useChatRuntime({
    api: "/api/chat",
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
};
```

## Step 4: Tools (optional)

To add tool calling support, define tools on the backend and render them on the frontend:

### Backend tool (AI SDK):

```ts
import { streamText, tool } from "ai";
import { z } from "zod";

const result = streamText({
  model: openai("gpt-5.4-nano"),
  messages,
  tools: {
    get_weather: tool({
      description: "Get weather for a location",
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => {
        return { temperature: 72, condition: "sunny", location };
      },
    }),
  },
});
```

### Frontend tool UI:

Create a toolkit with a renderer for the tool. The tool executes on the backend, so the entry uses `externalTool()` and only attaches UI:

```tsx
// app/toolkit.tsx
"use generative";

import { defineToolkit, externalTool } from "@assistant-ui/react";

export default defineToolkit({
  get_weather: {
    execute: externalTool(),
    render: ({ args, result }) => {
      return (
        <div>
          <p>Weather for {args?.location}</p>
          {result && <p>{result.temperature}F, {result.condition}</p>}
        </div>
      );
    },
  },
});
```

Register the toolkit in your assistant component:

```tsx
import { AssistantRuntimeProvider, Tools, useAui } from "@assistant-ui/react";
import toolkit from "@/app/toolkit";

const aui = useAui({
  tools: Tools({ toolkit }),
});

<AssistantRuntimeProvider aui={aui} runtime={runtime}>
  <Thread />
</AssistantRuntimeProvider>
```

Do not use `makeAssistantToolUI`, `useAssistantToolUI`, `makeAssistantTool`, or `useAssistantTool`; they are deprecated in favor of toolkits.

## Key Packages

| Package | Purpose |
|---------|---------|
| `@assistant-ui/react` | Core React components and primitives |
| `@assistant-ui/react-ai-sdk` | Vercel AI SDK integration |
| `@assistant-ui/react-markdown` | Markdown rendering |
| `@assistant-ui/react-syntax-highlighter` | Code highlighting |
| `@assistant-ui/ui` | Pre-built shadcn/ui component set |
| `@assistant-ui/styles` | Pre-built CSS for non-Tailwind users |

## Environment Variables

For OpenAI-based setups, ensure `OPENAI_API_KEY` is set in `.env.local`.
