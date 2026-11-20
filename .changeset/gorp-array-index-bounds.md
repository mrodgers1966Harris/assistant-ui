---
"@assistant-ui/gorp": patch
---

fix: reject array indexes in operations that are not in the range `0..length`, and apply operation batches atomically
