import { getLLMText } from "@/lib/get-llm-text";
import { getDistinctId, posthogServer } from "@/lib/posthog-server";
import { createPrismTracer } from "@/lib/prism-server";
import { injectQuoteContext } from "@assistant-ui/react-ai-sdk";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  validateClientToolsInput,
  validateDocChatInput,
} from "@/lib/validate-input";
import { source, examples as examplesSource } from "@/lib/source";
import { getModel } from "@/lib/ai/provider";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { prismAISDK } from "@aui-x/prism";
import { withTracing } from "@posthog/ai";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  zodSchema,
} from "ai";
import type * as PageTree from "fumadocs-core/page-tree";
import type { UIMessage } from "ai";
import z from "zod";

function normalizeSegment(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function findFolderByPath(
  tree: PageTree.Root,
  path: string,
): PageTree.Folder | undefined {
  const segments = path.split("/").filter(Boolean);
  let currentFolder: PageTree.Folder | undefined;
  let children: PageTree.Node[] = tree.children;

  for (const segment of segments) {
    const folder = children.find(
      (node): node is PageTree.Folder =>
        node.type === "folder" &&
        normalizeSegment(typeof node.name === "string" ? node.name : "") ===
          normalizeSegment(segment),
    );
    if (!folder) return undefined;
    currentFolder = folder;
    children = folder.children;
  }

  return currentFolder;
}

function listChildren(nodes: PageTree.Node[]) {
  return nodes.flatMap((node) => {
    const description =
      "description" in node && typeof node.description === "string"
        ? node.description
        : undefined;

    switch (node.type) {
      case "page":
        return {
          type: "page",
          title: node.name,
          url: node.url,
          ...(description ? { description } : {}),
        };
      case "folder":
        return {
          type: "folder",
          name: node.name,
          ...(node.index ? { url: node.index.url } : {}),
          ...(description ? { description } : {}),
        };
      default:
        return [];
    }
  });
}

const DOCS_PATH_ERROR = "Only local docs paths are supported";

function normalizeDocPath(slugOrUrl: string, routeUrl: string): string {
  const raw = slugOrUrl.trim();
  if (!raw) {
    throw new Error("Slug/path is required");
  }

  const current = new URL(routeUrl);
  const isAbsoluteUrl = /^https?:\/\//i.test(raw);

  if (!isAbsoluteUrl) {
    const cleaned = raw.replace(/^\/+/, "").replace(/^docs\//, "");
    if (!cleaned || cleaned.includes("..")) {
      throw new Error(DOCS_PATH_ERROR);
    }
    return cleaned;
  }

  const resolved = new URL(raw);
  if (resolved.origin !== current.origin) {
    throw new Error(DOCS_PATH_ERROR);
  }

  const cleaned = resolved.pathname.replace(/^\/+/, "").replace(/^docs\//, "");
  if (!cleaned || cleaned.includes("..")) {
    throw new Error(DOCS_PATH_ERROR);
  }

  return cleaned;
}

export const maxDuration = 300;

export const DOC_CHAT_PRUNE_OPTIONS = {
  toolCalls: "before-last-2-messages",
  reasoning: "none",
  emptyMessages: "remove",
} as const;

export async function prepareDocChatMessages(messages: readonly UIMessage[]) {
  const modelMessages = await convertToModelMessages(
    injectQuoteContext([...messages]),
  );

  return pruneMessages({
    messages: modelMessages,
    ...DOC_CHAT_PRUNE_OPTIONS,
  });
}

const MAX_PAGE_PATH_LENGTH = 512;

// The page context is resolved against the docs source on the server so that
// callers cannot place their own text in the system prompt.
function buildPageContext(pagePath: unknown): string | null {
  if (typeof pagePath !== "string" || pagePath.length > MAX_PAGE_PATH_LENGTH) {
    return null;
  }

  const [root, ...slugs] = pagePath.split("/").filter(Boolean);
  const page =
    root === "docs"
      ? source.getPage(slugs)
      : root === "examples"
        ? examplesSource.getPage(slugs)
        : undefined;
  if (!page) return null;

  return `The user is currently viewing: ${page.url}`;
}

const SYSTEM_PROMPT = `You are the assistant-ui docs assistant.

<about_assistant_ui>
assistant-ui is a React library for building AI chat interfaces. It provides:
- Composable UI primitives (Thread, Composer, Message, etc.)
- Runtime adapters for AI backends (Vercel AI SDK, LangGraph, custom stores)
- Pre-built components with full customization support
</about_assistant_ui>

<personality>
- Friendly, concise, developer-focused
- Answer the actual question - don't list documentation sections
- Use emoji sparingly (👋 for greetings, ✅ for success, etc.)
- Provide code snippets when they help clarify
- Link to relevant docs naturally within answers
</personality>

<greetings>
When users send a casual greeting (hey, hi, hello):
1. Welcome them to assistant-ui with emoji 👋
2. Briefly explain what assistant-ui helps them do (build AI chat interfaces in React)
3. Ask what they're working on or offer 2-3 common starting points

Example tone:
"Hey! 👋 Welcome to assistant-ui!

I'm here to help you build AI chat interfaces with React. Whether you're just getting started, connecting to an AI backend, or customizing components — I've got you covered.

What are you working on?"

Do NOT dump all documentation categories. Keep it conversational.
</greetings>

<tools>
You have two documentation tools:

1. **listDocs** - Browse documentation structure
   - Use with no path for root categories
   - Use with path (e.g., "ui", "runtimes") to see pages in that section
   - Returns: list of folders and pages with URLs

2. **readDoc** - Read a specific documentation page
   - Input: slug (e.g., "ui/thread") or URL (e.g., "/docs/ui/thread")
   - Returns: full page content

**Recommended patterns:**
- User asks a question → listDocs to find relevant section → readDoc to get content
- User mentions a specific path → readDoc directly
</tools>

<answering>
- Use the documentation tools to find relevant information
- **CRITICAL: ONLY use URLs that are explicitly returned by your tools**
- **NEVER guess or fabricate URLs** - if a tool didn't return a URL, don't link to it
- When linking, copy the exact URL from tool results: [Page Title](/docs/exact-path-from-tool)
- Prefer not linking over linking to a potentially non-existent page
- Admit uncertainty rather than guessing
</answering>

<formatting>
Use inline code (\`backticks\`) for:
- Components: \`Thread\`, \`Composer\`, \`Message\`
- Hooks: \`useChat\`, \`useThreadRuntime\`
- Props, parameters, types
- Packages: \`@assistant-ui/react\`
- File paths
</formatting>
`;

export async function POST(req: Request): Promise<Response> {
  try {
    const rateLimitResponse = await checkRateLimit(req);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await req.json();
    const { messages, tools, pagePath, config } = body;

    const prunedMessages = await prepareDocChatMessages(messages);

    const inputError = validateDocChatInput(prunedMessages);
    if (inputError) return inputError;

    const toolsError = validateClientToolsInput(tools);
    if (toolsError) return toolsError;

    const baseModel = getModel(config?.modelName);
    const distinctId = getDistinctId(req);
    const prismTracer = createPrismTracer();

    const posthogModel = posthogServer
      ? withTracing(baseModel, posthogServer, {
          posthogDistinctId: distinctId,
          posthogPrivacyMode: false,
          posthogProperties: {
            $ai_span_name: "docs_assistant_chat",
            source: "docs_assistant",
          },
        })
      : baseModel;

    const prism = prismTracer
      ? prismAISDK(prismTracer, posthogModel, {
          name: "docs_assistant",
          endUserId: distinctId,
        })
      : null;

    const result = streamText({
      model: prism?.model ?? posthogModel,
      system: [SYSTEM_PROMPT, buildPageContext(pagePath)]
        .filter(Boolean)
        .join("\n\n"),
      messages: prunedMessages,
      maxOutputTokens: 8192,
      stopWhen: stepCountIs(25),
      tools: {
        ...frontendTools(tools ?? {}),
        listDocs: tool({
          description:
            "List documentation pages. Use with no path for root categories, or specify path to browse a section.",
          inputSchema: zodSchema(
            z.object({
              path: z
                .string()
                .optional()
                .describe(
                  "Path to browse (e.g., 'ui', 'runtimes'). Empty for root.",
                ),
            }),
          ),
          execute: async ({ path }) => {
            const pageTree = source.pageTree;

            if (!path) {
              // Return root categories
              return [
                ...listChildren(
                  pageTree.children.filter(
                    (node): node is PageTree.Folder => node.type === "folder",
                  ),
                ),
                {
                  type: "folder",
                  name: "examples",
                  description:
                    "Examples of app types users can build with assistant-ui, showing instructions, recommended patterns, and UI structure.",
                },
              ];
            }

            const segments = path.split("/").filter(Boolean);
            if (segments[0] === "examples") {
              const rest = segments.slice(1).join("/");
              const target = rest
                ? findFolderByPath(examplesSource.pageTree, rest)
                : examplesSource.pageTree;
              if (!target) return { error: "Path not found" };
              return listChildren(target.children);
            }

            const targetFolder = findFolderByPath(pageTree, path);
            if (!targetFolder) return { error: "Path not found" };
            return listChildren(targetFolder.children);
          },
        }),
        readDoc: tool({
          description: "Read full content of a documentation page",
          inputSchema: zodSchema(
            z.object({
              slugOrUrl: z
                .string()
                .describe("Page slug (e.g., 'ui/thread') or URL"),
            }),
          ),
          execute: async ({ slugOrUrl }) => {
            let normalized: string;
            try {
              normalized = normalizeDocPath(slugOrUrl, req.url);
            } catch (error) {
              return {
                error:
                  error instanceof Error ? error.message : "Invalid docs path",
              };
            }

            const slugs = normalized.split("/").filter(Boolean);
            const isExample = slugs[0] === "examples";
            const docSource = isExample ? examplesSource : source;
            const docSlugs = isExample ? slugs.slice(1) : slugs;

            const page = docSource.getPage(docSlugs);
            if (!page) return { error: `Page not found: ${slugOrUrl}` };

            const content = await getLLMText(page);
            return { title: page.data.title, url: page.url, content };
          },
        }),
      },
      onFinish: async () => {
        await prism?.end();
      },
      onError: async ({ error }) => {
        console.error(error);
        await prism?.end({ status: "error" });
      },
      onAbort: async () => {
        await prism?.end();
      },
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      // gets usage and modelId for internal telemetry
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return { modelId: part.response.modelId };
        }
        if (part.type === "finish") {
          return { custom: { usage: part.totalUsage } };
        }
        return undefined;
      },
    });
  } catch (e) {
    console.error("[api/doc/chat]", e);
    return new Response("Request failed", { status: 500 });
  }
}
