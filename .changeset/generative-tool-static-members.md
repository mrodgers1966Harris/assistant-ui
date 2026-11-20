---
"@assistant-ui/x-generative-compiler": patch
---

fix: reject spreads, computed keys, `__proto__`, and duplicate members inside `"use generative"` tool and component objects so a server `execute` (or client `render`) can't bypass build-target routing
