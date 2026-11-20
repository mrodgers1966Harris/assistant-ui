import type { Tool } from "assistant-stream";
import { z } from "zod";
import { manageTasksParameters } from "@/components/docs/samples/interactable-state";

/**
 * Client-fulfilled tools that the docs demos and the hosted Expo/Ink examples
 * register against `/api/chat`. The route only forwards these definitions; a
 * request can opt into them by name but cannot change or add to them.
 */
export const GENERAL_CHAT_FRONTEND_TOOLS = {
  render_html: {
    description:
      "Whenever the user asks for HTML code, call this function. The user will see the HTML code rendered in their browser.",
    parameters: z.object({
      code: z.string(),
    }),
  },
  manage_tasks: {
    description:
      'Manage tasks on the task board. Actions: "add" (requires title), "toggle" (requires id), "remove" (requires id), "clear" (no extra fields).',
    parameters: manageTasksParameters,
  },
  weather_search: {
    description:
      "Find the weather in a location given a longitude and latitude",
    parameters: z.object({
      query: z.string(),
      longitude: z.number(),
      latitude: z.number(),
    }),
  },
} satisfies Record<string, Tool>;
