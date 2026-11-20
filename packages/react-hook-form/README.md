# `@assistant-ui/react-hook-form`

[React Hook Form](https://react-hook-form.com) integration for `@assistant-ui/react`. Replace `useForm` with `useAssistantForm` to give the assistant the ability to read and fill your form fields through tool calls.

## Installation

```bash
npm install @assistant-ui/react @assistant-ui/react-hook-form react-hook-form
```

## Usage

```tsx
"use client";

import { useAssistantForm } from "@assistant-ui/react-hook-form";

export function SignupForm() {
  const form = useAssistantForm({
    defaultValues: { firstName: "", lastName: "", email: "" },
    assistant: {
      tools: {
        set_form_field: { render: () => <FieldUpdated /> },
        submit_form: {
          render: ({ interrupt, resume }) =>
            interrupt ? (
              <ConfirmSubmit
                onConfirm={() => resume({ confirmed: true })}
                onCancel={() => resume({ confirmed: false })}
              />
            ) : (
              <FormSubmitted />
            ),
        },
      },
    },
  });

  return <form onSubmit={form.handleSubmit(onSubmit)}>{/* fields */}</form>;
}
```

The assistant gets three built-in tools: `set_form_field` to write values into fields registered on the form, `submit_form` to call your submit handler, and `reset_form` to restore the default values.

`submit_form` and `reset_form` never act on the model's call alone. They pause with a `human()` request and wait until your tool UI calls `resume({ confirmed: true })`. Any other payload declines. Submit is also refused if the form element or its values change while the request is pending. Without a `render` that calls `resume`, the form is never submitted or reset by the assistant.

## See also

- `@assistant-ui/react-lexical` if you also want a rich-text composer with `@`-mention support inside the same chat.

Full API reference at [assistant-ui.com/docs/api-reference/integrations/react-hook-form](https://www.assistant-ui.com/docs/api-reference/integrations/react-hook-form). See [`examples/with-react-hook-form`](https://github.com/assistant-ui/assistant-ui/tree/main/examples/with-react-hook-form) for a complete app.
