import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire, register } from "node:module"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

const requireFromTest = createRequire(
  new URL("./seroval-fromjson.test.mjs", import.meta.url),
)
const requireFromReactStart = createRequire(
  requireFromTest.resolve("@tanstack/react-start/package.json"),
)
const { generateServerFnResolverModule } = await import(
  new URL(
    "./dist/esm/start-compiler/server-fn-resolver-module.js",
    pathToFileURL(
      requireFromReactStart.resolve("@tanstack/start-plugin-core/package.json"),
    ),
  ).href
)

const serverFnsPath = new URL("./server-fns.mjs", import.meta.url).pathname
const resolverSource = generateServerFnResolverModule({
  includeClientReferencedCheck: true,
  useStaticImports: false,
  serverFnsById: {
    chat: {
      functionName: "chat",
      extractedFilename: serverFnsPath,
      isClientReferenced: true,
    },
    chatGet: {
      functionName: "chatGet",
      extractedFilename: serverFnsPath,
      isClientReferenced: true,
    },
    plain: {
      functionName: "plain",
      extractedFilename: serverFnsPath,
      isClientReferenced: true,
    },
    "gadget-fn": {
      functionName: "gadgetFn",
      extractedFilename: serverFnsPath,
      isClientReferenced: true,
    },
  },
})
const resolverDir = mkdtempSync(`${tmpdir()}/seroval-fromjson-`)
const resolverUrl = new URL("./resolver.mjs", pathToFileURL(`${resolverDir}/`))
writeFileSync(resolverUrl, resolverSource)
process.env.SEROVAL_TEST_RESOLVER_URL = resolverUrl.href
process.env.TSS_SERVER_FN_BASE ??= "/_serverFn/"
process.env.NODE_ENV ??= "production"

register(new URL("./loader.mjs", import.meta.url).href, {
  parentURL: import.meta.url,
})
