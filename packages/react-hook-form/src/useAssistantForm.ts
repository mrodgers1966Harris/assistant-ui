"use client";

import { type ModelContext, tool } from "@assistant-ui/core";
import type {} from "@assistant-ui/core/store";
import { type ToolCallMessagePartComponent } from "@assistant-ui/core/react";
import { useAui } from "@assistant-ui/store";
import { useEffect } from "react";
import {
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormProps,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import type { z } from "zod";
import { formTools } from "./formTools";

export type UseAssistantFormProps<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues,
> = UseFormProps<TFieldValues, TContext, TTransformedValues> & {
  assistant?:
    | {
        tools?:
          | {
              set_form_field?:
                | {
                    render?:
                      | ToolCallMessagePartComponent<
                          z.infer<
                            (typeof formTools.set_form_field)["parameters"]
                          >,
                          unknown
                        >
                      | undefined;
                  }
                | undefined;
              submit_form?:
                | {
                    render?:
                      | ToolCallMessagePartComponent<
                          z.infer<(typeof formTools.submit_form)["parameters"]>,
                          unknown
                        >
                      | undefined;
                  }
                | undefined;
              reset_form?:
                | {
                    render?:
                      | ToolCallMessagePartComponent<
                          z.infer<(typeof formTools.reset_form)["parameters"]>,
                          unknown
                        >
                      | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
};

export type AssistantFormConfirmationRequest = {
  action: "submit_form" | "reset_form";
  values: unknown;
};

export type AssistantFormConfirmationResponse = {
  confirmed: boolean;
};

const isConfirmed = (response: unknown) =>
  typeof response === "object" &&
  response !== null &&
  (response as { confirmed?: unknown }).confirmed === true;

const findFormElement = (control: Pick<Control, "_names" | "_fields">) => {
  const { _names, _fields } = control;
  for (const name of _names.mount) {
    const field = _fields[name];
    if (field?._f && "refs" in field._f) {
      const fieldReference = Array.isArray(field._f.refs)
        ? field._f.refs[0]
        : field._f.ref;

      if (fieldReference instanceof HTMLElement) {
        const form = fieldReference.closest("form");
        if (form) return form;
      }
    }
  }
  return null;
};

export const useAssistantForm = <
  TFieldValues extends FieldValues = FieldValues,
  TContext = any,
  TTransformedValues = TFieldValues,
>(
  props?: UseAssistantFormProps<TFieldValues, TContext, TTransformedValues>,
): UseFormReturn<TFieldValues, TContext, TTransformedValues> => {
  const form = useForm<TFieldValues, TContext, TTransformedValues>(props);
  const {
    control,
    getValues,
    setValue,
    reset,
    formState: { isSubmitting },
  } = form;

  const aui = useAui();
  useEffect(() => {
    const value: ModelContext = {
      system: `Form State:\n${JSON.stringify(getValues())}`,

      tools: {
        set_form_field: tool({
          ...formTools.set_form_field,
          parameters: formTools.set_form_field.parameters,
          execute: async (args) => {
            if (!control._names.mount.has(args.name)) {
              return {
                success: false,
                message: `Unknown form field "${args.name}".`,
              };
            }

            setValue(
              args.name as Path<TFieldValues>,
              args.value as PathValue<TFieldValues, Path<TFieldValues>>,
            );

            return { success: true };
          },
        }),
        submit_form: tool({
          ...formTools.submit_form,
          parameters: formTools.submit_form.parameters,
          execute: async (_args, { human }) => {
            if (isSubmitting) {
              return {
                success: false,
                message: "The form is already submitting.",
              };
            }

            const formElement = findFormElement(control);
            if (!formElement) {
              return {
                success: false,
                message:
                  "Unable retrieve the form element. This is a coding error.",
              };
            }

            const valuesSnapshot = JSON.stringify(getValues());
            const response = await human({
              action: "submit_form",
              values: JSON.parse(valuesSnapshot),
            } satisfies AssistantFormConfirmationRequest);

            if (!isConfirmed(response)) {
              return {
                success: false,
                message: "The user did not confirm submitting the form.",
              };
            }

            // The user confirmed the form and values captured above; refuse
            // rather than submit anything they did not see.
            if (
              !formElement.isConnected ||
              JSON.stringify(getValues()) !== valuesSnapshot
            ) {
              return {
                success: false,
                message:
                  "The form changed while waiting for confirmation. Ask the user to confirm again.",
              };
            }

            formElement.requestSubmit();
            return { success: true };
          },
        }),
        reset_form: tool({
          ...formTools.reset_form,
          parameters: formTools.reset_form.parameters,
          execute: async (_args, { human }) => {
            const response = await human({
              action: "reset_form",
              values: JSON.parse(JSON.stringify(getValues())),
            } satisfies AssistantFormConfirmationRequest);

            if (!isConfirmed(response)) {
              return {
                success: false,
                message: "The user did not confirm resetting the form.",
              };
            }

            reset();
            return { success: true };
          },
        }),
      },
    };
    return aui.modelContext().register({
      getModelContext: () => value,
    });
  }, [control, setValue, getValues, aui, reset, isSubmitting]);

  const renderFormFieldTool = props?.assistant?.tools?.set_form_field?.render;
  useEffect(() => {
    if (!renderFormFieldTool) return undefined;
    return aui.tools().setToolUI("set_form_field", renderFormFieldTool);
  }, [aui, renderFormFieldTool]);

  const renderSubmitFormTool = props?.assistant?.tools?.submit_form?.render;
  useEffect(() => {
    if (!renderSubmitFormTool) return undefined;
    return aui.tools().setToolUI("submit_form", renderSubmitFormTool);
  }, [aui, renderSubmitFormTool]);

  const renderResetFormTool = props?.assistant?.tools?.reset_form?.render;
  useEffect(() => {
    if (!renderResetFormTool) return undefined;
    return aui.tools().setToolUI("reset_form", renderResetFormTool);
  }, [aui, renderResetFormTool]);

  return form;
};
