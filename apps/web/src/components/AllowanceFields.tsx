import { ALLOWANCE_KINDS } from "@nearcited/shared";
import { Field } from "./Field";

interface AllowanceFieldsProps {
  /** What is typed for each kind: text for one that is counted, a tick for one that is not. */
  text: Record<string, string | boolean>;
  onChange: (text: Record<string, string | boolean>) => void;
  /** What is wrong with a kind's value, by kind. */
  errors?: Record<string, string>;
  /** True for a kind an announced reduction is going to lower: it stays as it is until the day. */
  held?: (kind: string) => boolean;
  onBlur?: () => void;
}

/**
 * A field for each kind of work a plan can include: a number a month for one that is counted, a
 * tick for one that is included or not. Nothing while no kind exists.
 */
export function AllowanceFields({ text, onChange, errors, held, onBlur }: AllowanceFieldsProps) {
  return (
    <>
      {Object.entries(ALLOWANCE_KINDS).map(([key, kind]) =>
        kind.counted ? (
          <Field
            key={key}
            label={kind.name}
            hint="A month, for each location. Leave it empty for none."
            inputMode="numeric"
            disabled={held?.(key)}
            value={String(text[key] ?? "")}
            error={errors?.[key]}
            onBlur={onBlur}
            onChange={(event) => onChange({ ...text, [key]: event.target.value })}
          />
        ) : (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={text[key] === true}
              disabled={held?.(key)}
              onChange={(event) => onChange({ ...text, [key]: event.target.checked })}
            />
            {kind.name}
          </label>
        ),
      )}
    </>
  );
}
