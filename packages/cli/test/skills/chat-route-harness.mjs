// Executes one POST against a generated chat route.
// global fetch is replaced before the route module loads, so the provider
// request is recorded here and is not sent to the network.
import { pathToFileURL } from "node:url";

const calls = [];

globalThis.fetch = async (url, init) => {
  const rawHeaders = init?.headers ?? {};
  const headers =
    typeof Headers !== "undefined" && rawHeaders instanceof Headers
      ? Object.fromEntries(rawHeaders.entries())
      : Object.fromEntries(
          Object.entries(rawHeaders).map(([key, value]) => [
            String(key).toLowerCase(),
            value,
          ]),
        );
  let body = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // Keep the raw body when the provider did not send JSON.
    }
  }
  calls.push({ url: String(url), headers, body });
  return new Response(
    JSON.stringify({
      error: { message: "stopped", type: "invalid_request_error" },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
};

const input = JSON.parse(await readStdin());
const { POST } = await import(pathToFileURL(process.argv[2]).href);

let status = null;
let thrown = null;
try {
  const response = await POST(
    new Request("http://app.example/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(input.body),
    }),
  );
  status = response?.status ?? null;
} catch (error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  thrown = `${name}: ${message}`;
}

await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write(JSON.stringify({ status, thrown, calls }));

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", reject);
  });
}
