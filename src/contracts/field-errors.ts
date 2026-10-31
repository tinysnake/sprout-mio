import type { z } from "zod";

export type FieldErrors = Record<string, string>;

/** 同一字段只保留第一条消息，路径为空的错误归到 form。 */
export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "form";
    errors[field] ??= issue.message;
  }
  return errors;
}
