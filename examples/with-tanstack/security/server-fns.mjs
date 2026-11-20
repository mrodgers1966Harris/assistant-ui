const state = (globalThis.__serovalFromJsonTest ??= { events: [] })

function record(event) {
  state.events.push(event)
}

export async function chat() {
  record({ kind: "handler", id: "chat" })
  throw new Error("validator rejected")
}
chat.method = "POST"

export async function chatGet() {
  record({ kind: "handler", id: "chatGet" })
  throw new Error("validator rejected")
}
chatGet.method = "GET"

export async function plain(payload) {
  record({
    kind: "handler",
    id: "plain",
    messages: payload?.data?.messages?.length ?? null,
  })
  return { result: "ok" }
}
plain.method = "POST"

export async function gadgetFn(opts, signal) {
  record({
    kind: "revived",
    optsType: typeof opts,
    signalType: typeof signal,
  })
  return { result: null }
}
