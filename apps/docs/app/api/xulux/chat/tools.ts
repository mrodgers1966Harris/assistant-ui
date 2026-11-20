import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { createDocsTools } from "./tools/docs-tools";
import { createSandboxTools } from "./tools/sandbox-tools";

export function createXuluxChatTools({
  clientTools,
  sessionId,
  routeUrl,
}: {
  clientTools: Parameters<typeof frontendTools>[0] | undefined;
  sessionId: string | undefined;
  routeUrl: string;
}) {
  return {
    ...frontendTools(clientTools ?? {}),
    ...createSandboxTools({ sessionId }),
    ...createDocsTools({ routeUrl }),
  };
}
