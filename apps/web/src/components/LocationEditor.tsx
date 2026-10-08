import {
  formatPhone,
  type Location,
  type LocationFormValues,
  LocationInputSchema,
  type ScanFrequency,
} from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { cadence } from "../lib/format";
import { locationFormValues } from "../lib/location";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

type TextField = Exclude<keyof LocationFormValues, "scan_frequency">;

const FREQUENCIES: { value: ScanFrequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "off", label: "Off" },
];

interface LocationEditorProps {
  location: Location;
  /** How many days apart the organization's plan scans. Undefined until it has loaded. */
  planDays: number | undefined;
  onSaved: () => void;
}

/** What "Daily" and "Weekly" come to on this plan. The plan sets the fastest pace. */
function frequencyNote(frequency: ScanFrequency, planDays: number | undefined): string {
  if (frequency === "off") return "No scheduled scans. You can still run one by hand.";
  if (planDays === undefined) return "Scanned on a schedule.";
  const pace = cadence(planDays, frequency);
  return frequency === "daily"
    ? `Scanned ${pace}, as often as your plan allows.`
    : `Scanned ${pace}. A location can ask for less than its plan allows, never more.`;
}

/** The form that changes a location's details and how often it is scanned. */
export function LocationEditor({ location, planDays, onSaved }: LocationEditorProps) {
  const [form, setForm] = useState<Required<LocationFormValues>>(() =>
    locationFormValues(location),
  );
  const save = useMutation({
    mutationFn: (values: LocationFormValues) => api.updateLocation(location.id, values),
    onSuccess: (saved) => {
      // The server tidies what it stores (trimmed text, an upper-case country), so show that.
      setForm(locationFormValues(saved));
      onSaved();
    },
  });

  const form$ = useFormErrors(LocationInputSchema, form);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) save.mutate(form);
  }
  const field = (name: TextField) => ({
    value: form[name] ?? "",
    error: form$.error(name),
    onBlur: () => form$.touch(name),
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [name]: event.target.value })),
  });
  const phone = field("phone");

  return (
    <form onSubmit={submit} className="card settings-main" noValidate>
      <div>
        <h2>Business details</h2>
        <p className="small muted">Scans ask about the business by this name, in this city.</p>
      </div>
      <div className="field-grid">
        <Field label="Business name" required maxLength={120} {...field("name")} />
        <Field
          label="Category"
          maxLength={120}
          placeholder="Pizza restaurant"
          {...field("primary_category")}
        />
        <Field
          label="Website"
          inputMode="url"
          autoCapitalize="none"
          placeholder="joespizza.com"
          maxLength={200}
          {...field("website")}
        />
        <Field
          label="Phone"
          type="tel"
          autoComplete="tel"
          maxLength={40}
          {...phone}
          // Once the number is whole, it is set out the way it is written in this country.
          onBlur={() => {
            phone.onBlur();
            setForm((current) => ({
              ...current,
              phone: formatPhone(current.phone ?? "", (current.country_code ?? "").toUpperCase()),
            }));
          }}
        />
        <Field
          label="Street address"
          autoComplete="street-address"
          maxLength={200}
          {...field("address_line")}
        />
        <Field label="City" required maxLength={80} {...field("city")} />
        <Field label="State or region" maxLength={80} {...field("region")} />
        <Field
          label="Postal code"
          autoComplete="postal-code"
          maxLength={20}
          {...field("postal_code")}
        />
        <Field
          label="Country code"
          required
          maxLength={2}
          autoCapitalize="characters"
          hint="Two letters, like US. Phone and postal code are read for this country."
          {...field("country_code")}
        />
        <Field
          label="Google place ID"
          autoCapitalize="none"
          maxLength={200}
          {...field("google_place_id")}
        />
      </div>

      <hr className="divider" />
      <h3>Scheduled scans</h3>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be laid out as a pill group */}
      <div className="segmented" role="group" aria-label="Scheduled scans">
        {FREQUENCIES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={form.scan_frequency === value}
            onClick={() => setForm((current) => ({ ...current, scan_frequency: value }))}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="small muted">{frequencyNote(form.scan_frequency, planDays)}</p>

      <button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving" : "Save changes"}
      </button>
      {save.isSuccess && !save.isPending && (
        <p className="small muted" role="status">
          Saved.
        </p>
      )}
      <ErrorNote error={save.error} />
    </form>
  );
}
