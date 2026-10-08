import { type InputHTMLAttributes, useId } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** What is wrong with the value, shown under the field. */
  error?: string;
  /** A line of help under the field when there is nothing wrong. */
  hint?: string;
}

/** A labelled text field that says what is wrong with it, to the eye and to a screen reader. */
export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const note = error ?? hint;
  return (
    <label>
      {label}
      <input
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? id : undefined}
      />
      {note && (
        <span
          id={id}
          className={error ? "field-error" : "field-hint"}
          role={error ? "alert" : undefined}
        >
          {note}
        </span>
      )}
    </label>
  );
}
