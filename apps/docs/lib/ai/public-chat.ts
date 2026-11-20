import type { UIMessage } from "ai";
import {
  toToolsJSONSchema,
  type Tool,
  type ToolJSONSchema,
} from "assistant-stream";

const CONVERSATION_ROLES = new Set<unknown>(["user", "assistant"]);

/**
 * Public chat routes take instructions only from the server. Messages with any
 * role other than `user` or `assistant` (notably `system`) are dropped so a
 * caller cannot supply their own system prompt through the message history.
 */
export function conversationMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.filter(
    (message): message is UIMessage =>
      typeof message === "object" &&
      message !== null &&
      CONVERSATION_ROLES.has((message as { role?: unknown }).role),
  );
}

/**
 * Exposes client-fulfilled tools by name only. Descriptions and schemas always
 * come from `definitions`; requested names the server does not define are
 * ignored.
 */
export function selectFrontendTools(
  definitions: Record<string, Tool>,
  requested: unknown,
): Record<string, ToolJSONSchema> {
  if (typeof requested !== "object" || requested === null) return {};

  const selected: Record<string, Tool> = {};
  for (const name of Object.keys(requested)) {
    const definition = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (definition) selected[name] = definition;
  }
  return toToolsJSONSchema(selected);
}
