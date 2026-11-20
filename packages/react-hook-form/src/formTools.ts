import { z } from "zod";

export const formTools = {
  set_form_field: {
    description:
      "Sets a form field. Only fields registered on the form can be set. Call this function as soon as the user provides the data for each field.",
    parameters: z.object({
      name: z.string(),
      value: z.string(),
    }),
  },
  submit_form: {
    description:
      "Asks the user to confirm submitting the form. The form is submitted only after the user confirms in the UI.",
    parameters: z.object({}),
  },
  reset_form: {
    description:
      "Asks the user to confirm resetting all form fields to their initial values. The form is reset only after the user confirms in the UI.",
    parameters: z.object({}),
  },
};
