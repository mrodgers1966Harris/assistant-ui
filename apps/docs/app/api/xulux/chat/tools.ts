import { createDocsTools } from "./tools/docs-tools";
import { createSandboxTools } from "./tools/sandbox-tools";
import { createSourceMapTools } from "./tools/source-map-tools";

export function createXuluxChatTools({
  sessionId,
  routeUrl,
}: {
  sessionId: string | undefined;
  routeUrl: string;
}) {
  return {
    ...createSourceMapTools(),
    ...createSandboxTools({ sessionId }),
    ...createDocsTools({ routeUrl }),
  };
}
