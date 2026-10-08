import {
  type Location,
  type LocationDetail,
  type LocationFormValues,
  type Organization,
  SURFACE_LABELS,
  type Surface,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { Labelled } from "../components/Labelled";
import { RateCell } from "../components/RateCell";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { placeOf, useDetails, useTrends } from "../lib/locations";
import { CHANGE_OVER_SCANS, scoreChange, signed, sparkline, surfaceRates } from "../lib/summary";
import type { TrendPoint } from "../lib/trend";

const EMPTY: LocationFormValues = { name: "", city: "", region: "", website: "" };
/** The columns shown before any location says which assistants its scans check. */
const USUAL_SURFACES: Surface[] = ["chatgpt", "claude"];

/** Every location in the organization, as one table: how visible, which way it is moving, what next. */
export function Locations({ organization }: { organization: Organization }) {
  const [params, setParams] = useSearchParams();
  const adding = params.has("add");
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const list = locations.data ?? [];
  const trends = useTrends(list);
  const details = useDetails(list);

  const checked = [...details.values()].find((detail) => detail?.surfaces.length)?.surfaces;
  const surfaces = checked ?? USUAL_SURFACES;
  const columns = `minmax(10.5rem,1.7fr) 8rem 3.25rem ${surfaces.map(() => "4.75rem").join(" ")} minmax(7.5rem,1.1fr) minmax(0,1.5fr)`;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="small muted">
            {organization.name}
            {locations.data &&
              ` · ${list.length} of ${organization.max_locations} ${organization.max_locations === 1 ? "location" : "locations"}`}
          </p>
          <h1>Locations</h1>
        </div>
        {!adding && (
          <button type="button" className="fill-narrow" onClick={() => setParams({ add: "1" })}>
            Add location
          </button>
        )}
      </div>

      {adding && (
        <AddLocation organization={organization} used={list.length} onClose={() => setParams({})} />
      )}

      {locations.isPending && <p className="status">Loading locations</p>}
      <ErrorNote error={locations.error} />

      {locations.data && list.length === 0 && !adding && (
        <p className="lede">
          No locations yet. Add the first storefront or service area you want to track.
        </p>
      )}

      {list.length > 0 && (
        <>
          <div className="gtable-scroll">
            <div
              className="gtable stacks"
              style={{ "--cols": columns, "--min": `${43 + surfaces.length * 6}rem` } as never}
            >
              <div className="gtable-head">
                <span>Location</span>
                <span>Visibility</span>
                <span>Change</span>
                {surfaces.map((surface) => (
                  <span key={surface} className="center">
                    {SURFACE_LABELS[surface]}
                  </span>
                ))}
                <span>Named most instead</span>
                <span>Next step</span>
              </div>
              {list.map((location) => (
                <Row
                  key={location.id}
                  location={location}
                  trend={trends.get(location.id) ?? []}
                  detail={details.get(location.id)}
                  surfaces={surfaces}
                />
              ))}
            </div>
          </div>
          <p className="footnote">
            Visibility is a 0 to 100 score counted over each location's last {CHANGE_OVER_SCANS}{" "}
            scans: 100 means named first in every answer. The assistant columns show the share of
            answers that named the location, shaded darker as it rises. Change compares with{" "}
            {CHANGE_OVER_SCANS} scans ago, or with the first scan when there are fewer.
          </p>
        </>
      )}
    </main>
  );
}

interface RowProps {
  location: Location;
  trend: TrendPoint[];
  detail: LocationDetail | undefined;
  surfaces: readonly Surface[];
}

function Row({ location, trend, detail, surfaces }: RowProps) {
  const score = trend[trend.length - 1]?.score;
  const change = scoreChange(trend);
  const line = sparkline(
    trend.map((point) => point.score),
    72,
    24,
  );
  const scanned = score !== undefined;
  const rates = surfaceRates(detail?.window.cells ?? [], surfaces);
  const rival = detail?.actions.find((action) => action.id === "competitors")?.items[0];
  const steps = detail?.actions ?? [];

  return (
    <Link to={`/locations/${location.id}`} className="gtable-row">
      <span className="stack-tight">
        <span className="loc-name ellipsis">{location.name}</span>
        <span className="small muted ellipsis">
          {placeOf(location)} ·{" "}
          {location.last_scanned_at
            ? `scanned ${formatDate(location.last_scanned_at)}`
            : "not scanned yet"}
        </span>
      </span>

      <Labelled label="Visibility">
        <span className="loc-score">
          <span className="display">{score ?? "—"}</span>
          {line && (
            <svg className="spark" viewBox="0 0 72 24" aria-hidden="true">
              <path d={line} />
            </svg>
          )}
        </span>
      </Labelled>

      <Labelled label="Change">
        <span
          className={`change${change && change.by > 0 ? " up" : ""}${change && change.by < 0 ? " down" : ""}`}
          title={change ? `Compared with ${change.scans} scans ago` : undefined}
        >
          {change ? signed(change.by) : "—"}
        </span>
      </Labelled>

      {rates.map(({ surface, rate }) => (
        <Labelled key={surface} label={SURFACE_LABELS[surface]}>
          <RateCell
            rate={scanned ? rate : null}
            title={`Share of ${SURFACE_LABELS[surface]} answers that named this location`}
          />
        </Labelled>
      ))}

      <Labelled label="Named most instead" wide>
        <span className="stack-tight">
          <span className="ellipsis">{rival?.label ?? "—"}</span>
          <span className="mono muted ellipsis">
            {rival ? rival.detail : scanned ? "Nobody else named" : "After the first scan"}
          </span>
        </span>
      </Labelled>

      <Labelled label="Next step" wide>
        <span className="next-step">
          {!scanned ? (
            <span className="muted">Waiting for first scan</span>
          ) : steps[0] ? (
            <>
              <span className="pill">
                {steps.length} {steps.length === 1 ? "step" : "steps"}
              </span>
              <span className="ellipsis">{steps[0].title}</span>
            </>
          ) : (
            <span className="muted">Nothing to do yet</span>
          )}
        </span>
      </Labelled>
    </Link>
  );
}

interface AddLocationProps {
  organization: Organization;
  used: number;
  onClose: () => void;
}

function AddLocation({ organization, used, onClose }: AddLocationProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LocationFormValues>(EMPTY);
  const create = useMutation({
    mutationFn: () => api.createLocation(organization.id, form),
    onSuccess: async (location) => {
      await queryClient.invalidateQueries({ queryKey: ["locations", organization.id] });
      // A new location has nothing to scan until it has prompts, so that is where it opens.
      navigate(`/locations/${location.id}?tab=prompts`);
    },
  });

  // The database enforces the limit. This only saves a round trip and says why.
  const atLimit = used >= organization.max_locations;

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
    <form onSubmit={submit} className="card inline-card">
      <h2>Add a location</h2>
      <div className="field-grid">
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
      </div>
      <div className="row">
        <button type="submit" disabled={create.isPending || atLimit}>
          {create.isPending ? "Adding location" : "Add location"}
        </button>
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
        <span className="small muted">
          {used} of {organization.max_locations} locations used.
          {atLimit && " Remove one, or ask for a higher limit, to add another."}
        </span>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}
