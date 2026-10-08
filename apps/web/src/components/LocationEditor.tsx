import type { Location, LocationFormValues, ScanFrequency } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { cadence } from "../lib/format";
import { locationFormValues } from "../lib/location";
import { ErrorNote } from "./ErrorNote";

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

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(form);
  }
  const field = (name: TextField) => ({
    value: form[name] ?? "",
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [name]: event.target.value })),
  });

  return (
    <form onSubmit={submit} className="card settings-main">
      <div>
        <h2>Business details</h2>
        <p className="small muted">Scans ask about the business by this name, in this city.</p>
      </div>
      <div className="field-grid">
        <label>
          Business name
          <input required maxLength={120} {...field("name")} />
        </label>
        <label>
          Category
          <input maxLength={120} placeholder="Pizza restaurant" {...field("primary_category")} />
        </label>
        <label>
          Website
          <input type="url" placeholder="https://" maxLength={200} {...field("website")} />
        </label>
        <label>
          Phone
          <input type="tel" maxLength={40} {...field("phone")} />
        </label>
        <label>
          Street address
          <input maxLength={200} {...field("address_line")} />
        </label>
        <label>
          City
          <input required maxLength={80} {...field("city")} />
        </label>
        <label>
          State or region
          <input maxLength={80} {...field("region")} />
        </label>
        <label>
          Postal code
          <input maxLength={20} {...field("postal_code")} />
        </label>
        <label>
          Country code
          <input required minLength={2} maxLength={2} {...field("country_code")} />
        </label>
        <label>
          Google place ID
          <input maxLength={200} {...field("google_place_id")} />
        </label>
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
