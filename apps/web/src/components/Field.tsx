import { type InputHTMLAttributes, useId } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** What is wrong with the value, shown under the field. */
  error?: string;
  /** A line of help under the field when there is nothing wrong. */
  hint?: string;
}

/**
 * A labelled text field that says what is wrong with it, to the eye and to a screen reader.
 *
 * The line under the field is always there, empty or not. A message that arrived by pushing the
 * form down would move the button the reader is in the middle of clicking, and the click would
 * land on nothing.
 */
export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const note = error ?? hint;
  return (
    // The message sits beside the label, not inside it, so the field keeps one name whatever is
    // wrong with it: "Phone", never "Phone Enter a full phone number".
    <div className="field">
      <label>
        {label}
        <input
          {...input}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? id : undefined}
        />
      </label>
      <span
        id={id}
        className={error ? "field-note field-error" : "field-note"}
        role={error ? "alert" : undefined}
      >
        {note}
      </span>
    </div>
  );
}
