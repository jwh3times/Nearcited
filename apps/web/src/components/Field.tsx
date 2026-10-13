import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";

interface Noted {
  label: string;
  /** What is wrong with the value, shown under the field. */
  error?: string;
  /** A line of help under the field when there is nothing wrong. */
  hint?: string;
}

/** The line under a field, and what ties the field to it for a screen reader. */
function useNote(error: string | undefined, hint: string | undefined) {
  const id = useId();
  const note = error ?? hint;
  return {
    control: {
      "aria-invalid": error ? (true as const) : undefined,
      "aria-describedby": note ? id : undefined,
    },
    line: (
      <span
        id={id}
        className={error ? "field-note field-error" : "field-note"}
        role={error ? "alert" : undefined}
      >
        {note}
      </span>
    ),
  };
}

type FieldProps = Noted & InputHTMLAttributes<HTMLInputElement>;

/**
 * A labelled text field that says what is wrong with it, to the eye and to a screen reader.
 *
 * The line under the field is always there, empty or not. A message that arrived by pushing the
 * form down would move the button the reader is in the middle of clicking, and the click would
 * land on nothing.
 */
export function Field({ label, error, hint, ...input }: FieldProps) {
  const note = useNote(error, hint);
  return (
    // The message sits beside the label, not inside it, so the field keeps one name whatever is
    // wrong with it: "Phone", never "Phone Enter a full phone number".
    <div className="field">
      <label>
        {label}
        <input {...input} {...note.control} />
      </label>
      {note.line}
    </div>
  );
}

type LongFieldProps = Noted & TextareaHTMLAttributes<HTMLTextAreaElement>;

/** The same for a few sentences. It takes the whole width of the form it is in. */
export function LongField({ label, error, hint, ...area }: LongFieldProps) {
  const note = useNote(error, hint);
  return (
    <div className="field wide">
      <label>
        {label}
        <textarea rows={4} {...area} {...note.control} />
      </label>
      {note.line}
    </div>
  );
}
