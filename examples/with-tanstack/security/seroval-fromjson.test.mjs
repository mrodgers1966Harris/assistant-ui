import assert from "node:assert/strict"
import { test } from "node:test"

const { createStartHandler } = await import("@tanstack/react-start/server")

const str = (value) => ({ t: 1, s: value })
const obj = (id, keys, values) => ({
  t: 10,
  i: id,
  o: 0,
  p: { k: keys, v: values },
})

const gadgetPayload = {
  t: {
    t: 12,
    s: 1,
    i: 1,
    f: obj(2, ["then"], [
      {
        t: 25,
        i: 3,
        c: "$TSR/t/$TSS/serverfn",
        s: {
          v: obj(4, ["functionId"], [str("gadget-fn")]),
        },
      },
    ]),
  },
  f: 63,
  m: [],
}

const ordinaryPayload = {
  t: obj(1, ["data"], [
    obj(2, ["messages"], [
      {
        t: 9,
        i: 3,
        o: 0,
        a: [obj(4, ["role", "content"], [str("user"), str("hello")])],
      },
    ]),
  ]),
  f: 63,
  m: [],
}

const state = (globalThis.__serovalFromJsonTest ??= { events: [] })
const handler = createStartHandler(() => new Response("html"))
const origin = "http://victim.example"

function events() {
  return state.events.map((event) => ({ ...event }))
}

function revived() {
  return state.events.filter((event) => event.kind === "revived")
}

async function send(request) {
  state.events.length = 0
  const restore = muteConsole()
  let response
  try {
    response = await handler(request)
  } finally {
    restore()
  }
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { status: response.status, events: events(), revived: revived() }
}

function muteConsole() {
  const error = console.error
  const info = console.info
  console.error = () => {}
  console.info = () => {}
  return () => {
    console.error = error
    console.info = info
  }
}

test("ordinary JSON still reaches the server function", async () => {
  const result = await send(
    new Request(`${origin}/_serverFn/plain`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(ordinaryPayload),
    }),
  )
  assert.deepEqual(result.revived, [])
  assert.equal(
    result.events.some(
      (event) =>
        event.kind === "handler" &&
        event.id === "plain" &&
        event.messages === 1,
    ),
    true,
  )
})

test("a fulfilled promise thenable in a POST body does not run plugin-revived code", async () => {
  const result = await send(
    new Request(`${origin}/_serverFn/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(gadgetPayload),
    }),
  )
  assert.deepEqual(result.revived, [])
})

test("a fulfilled promise thenable in a GET payload does not run plugin-revived code", async () => {
  const url = new URL(`${origin}/_serverFn/chatGet`)
  url.searchParams.set("payload", JSON.stringify(gadgetPayload))
  const result = await send(
    new Request(url, {
      method: "GET",
      headers: { origin },
    }),
  )
  assert.deepEqual(result.revived, [])
})

test("a fulfilled promise thenable in multipart form context does not run plugin-revived code", async () => {
  const form = new FormData()
  form.set("__TSS_CONTEXT", JSON.stringify(gadgetPayload))
  const result = await send(
    new Request(`${origin}/_serverFn/chat`, {
      method: "POST",
      headers: { origin },
      body: form,
    }),
  )
  assert.deepEqual(result.revived, [])
})

test("a cross-site Origin is refused before deserialization", async () => {
  const result = await send(
    new Request(`${origin}/_serverFn/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify(gadgetPayload),
    }),
  )
  assert.equal(result.status, 403)
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.revived, [])
})
