import { fieldErrors } from "@nearcited/shared";
import { useState } from "react";
import type { z } from "zod";

export interface FormErrors {
  /** The message to show under a field, once the reader has left it or tried to submit. */
  error: (field: string) => string | undefined;
  /** Marks a field as left, so its message may show. For an input's `onBlur`. */
  touch: (field: string) => void;
  /** Shows every message, and says whether the form may go ahead. For `onSubmit`. */
  check: () => boolean;
  /** Hides the messages again, for a form that has been sent and cleared. */
  reset: () => void;
}

/**
 * Checks a form's values against the schema the API will check them with, so the reader is told
 * what is wrong beside the field, in the same words, before anything is sent.
 *
 * A message waits until its field has been left or the form submitted: nobody wants to be told
 * a phone number is too short while they are still typing it.
 */
export function useFormErrors(schema: z.ZodType, values: unknown): FormErrors {
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const errors = fieldErrors(schema, values);

  return {
    error: (field) => (submitted || touched.has(field) ? errors[field] : undefined),
    touch: (field) => setTouched((current) => new Set(current).add(field)),
    check: () => {
      setSubmitted(true);
      return Object.keys(errors).length === 0;
    },
    reset: () => {
      setTouched(new Set());
      setSubmitted(false);
    },
  };
}
