---
"@assistant-ui/react-hook-form": patch
"@assistant-ui/core": patch
---

fix(react-hook-form): `submit_form` and `reset_form` now wait for the user to confirm through `resume({ confirmed: true })` before acting, submit only the form bound when the call was made (refusing if it or its values changed), and `set_form_field` only writes fields registered on the form. The tool invocation tracker now keeps an `interrupt` status raised synchronously from `execute`.
