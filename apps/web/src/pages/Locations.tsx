import type { LocationFormValues, Organization } from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";

const EMPTY: LocationFormValues = { name: "", city: "", region: "", website: "" };

export function Locations({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const queryKey = ["locations", organization.id];
  const locations = useQuery({ queryKey, queryFn: () => api.listLocations(organization.id) });

  const [form, setForm] = useState<LocationFormValues>(EMPTY);
  const create = useMutation({
    mutationFn: () => api.createLocation(organization.id, form),
    onSuccess: () => {
      setForm(EMPTY);
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }
  const field = (name: keyof LocationFormValues) => ({
    value: (form[name] as string | undefined) ?? "",
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [name]: event.target.value })),
  });

  return (
    <>
      <h1>Locations</h1>

      {locations.isPending && <p className="status">Loading locations</p>}
      <ErrorNote error={locations.error} />

      {locations.data?.length === 0 && (
        <p className="lede">
          No locations yet. Add the first storefront or service area you want to track.
        </p>
      )}

      {locations.data && locations.data.length > 0 && (
        <ul className="rows">
          {locations.data.map((location) => (
            <li key={location.id}>
              <Link to={`/locations/${location.id}`} className="row-title">
                {location.name}
              </Link>
              <span>{[location.city, location.region].filter(Boolean).join(", ")}</span>
              <span className="muted">
                {location.last_scanned_at
                  ? `Scanned ${formatDate(location.last_scanned_at)}`
                  : "Not scanned yet"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <section className="section">
        <h2>Add a location</h2>
        <form onSubmit={submit} className="grid-form">
          <label>
            Business name
            <input required maxLength={120} {...field("name")} />
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
            Website
            <input type="url" placeholder="https://" maxLength={200} {...field("website")} />
          </label>
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding location" : "Add location"}
          </button>
        </form>
        <ErrorNote error={create.error} />
      </section>
    </>
  );
}
