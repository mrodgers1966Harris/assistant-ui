import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const requireFromTest = createRequire(
  new URL("./seroval-fromjson.test.mjs", import.meta.url),
)
const requireFromReactStart = createRequire(
  requireFromTest.resolve("@tanstack/react-start/package.json"),
)
const clientCorePackage = pathToFileURL(
  requireFromReactStart.resolve("@tanstack/start-client-core/package.json"),
)

const redirects = new Map([
  [
    "#tanstack-router-entry",
    new URL("./dist/esm/fake-entries/router.js", clientCorePackage).href,
  ],
  [
    "#tanstack-start-entry",
    new URL("./dist/esm/fake-entries/start.js", clientCorePackage).href,
  ],
])

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "#tanstack-start-server-fn-resolver") {
    const url = process.env.SEROVAL_TEST_RESOLVER_URL
    if (!url) {
      throw new Error("SEROVAL_TEST_RESOLVER_URL is not set")
    }
    return { url, shortCircuit: true }
  }
  const redirected = redirects.get(specifier)
  if (redirected) {
    return { url: redirected, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
