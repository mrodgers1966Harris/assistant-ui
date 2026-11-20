---
"assistant-ui": patch
---

fix: the skill's sample chat route requires a session and forwards only the message list instead of spreading the request's `config` into `streamText`
