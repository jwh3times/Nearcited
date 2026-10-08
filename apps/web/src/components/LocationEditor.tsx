import type { Location, LocationFormValues } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { locationFormValues, SCAN_FREQUENCY_LABELS } from "../lib/location";
import { ErrorNote } from "./ErrorNote";

type TextField = Exclude<keyof LocationFormValues, "scan_frequency">;

/** The form that changes a location's details. Closed until asked for. */
export function LocationEditor({ location, onSaved }: { location: Location; onSaved: () => void }) {
  const [form, setForm] = useState<Required<LocationFormValues> | null>(null);
  const save = useMutation({
    mutationFn: (values: LocationFormValues) => api.updateLocation(location.id, values),
    onSuccess: () => {
      setForm(null);
      onSaved();
    },
  });

  if (!form) {
    return (
      <button
        type="button"
        className="secondary"
        onClick={() => setForm(locationFormValues(location))}
      >
        Edit details
      </button>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form) save.mutate(form);
  }
  const field = (name: TextField) => ({
    value: form[name] ?? "",
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => current && { ...current, [name]: event.target.value }),
  });

  return (
    <>
      <form onSubmit={submit} className="grid-form">
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
        <label>
          Scheduled scans
          <select
            value={form.scan_frequency}
            onChange={(event) =>
              setForm(
                (current) =>
                  current && {
                    ...current,
                    scan_frequency: event.target.value as typeof current.scan_frequency,
                  },
              )
            }
          >
            {(["daily", "weekly", "off"] as const).map((frequency) => (
              <option key={frequency} value={frequency}>
                {SCAN_FREQUENCY_LABELS[frequency]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving" : "Save details"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={save.isPending}
          onClick={() => {
            save.reset();
            setForm(null);
          }}
        >
          Cancel
        </button>
      </form>
      <ErrorNote error={save.error} />
    </>
  );
}
