import type { Location, Organization } from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ErrorNote } from "./ErrorNote";

interface PausedByPlanProps {
  location: Location;
  organization: Organization;
  /** True while the operator is reading a customer's account, where nothing is changed. */
  readOnly: boolean;
}

/**
 * Shown on a location its organization's plan no longer covers. Nothing was deleted: the page
 * below is everything measured so far. The owner can scan this one in place of another.
 */
export function PausedByPlan({ location, organization, readOnly }: PausedByPlanProps) {
  const queryClient = useQueryClient();
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const inUse = (locations.data ?? []).filter(
    (other) => other.id !== location.id && !other.paused_by_plan,
  );
  const activate = useMutation({
    mutationFn: (insteadOf: string | null) => api.activateLocation(location.id, insteadOf),
    // The sidebar, the list and this page all show which locations are in use.
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const covered = organization.max_locations;
  const room = inUse.length < covered;

  return (
    <div className="card notice paused-by-plan" role="status">
      <p>
        <strong>This location is paused.</strong> Your plan covers {covered}{" "}
        {covered === 1 ? "location" : "locations"}, so this one is not being scanned. Everything
        measured so far is still here.
      </p>
      {!readOnly && locations.data && (
        <div className="head-actions">
          {room ? (
            <button
              type="button"
              disabled={activate.isPending}
              onClick={() => activate.mutate(null)}
            >
              Scan this location again
            </button>
          ) : (
            inUse.map((other) => (
              <button
                key={other.id}
                type="button"
                className="secondary"
                disabled={activate.isPending}
                onClick={() => activate.mutate(other.id)}
              >
                Scan this one instead of {other.name}
              </button>
            ))
          )}
        </div>
      )}
      <ErrorNote error={activate.error} />
    </div>
  );
}
