import type { Location, LocationDetail, Scan } from "@nearcited/shared";
import { useQueries } from "@tanstack/react-query";
import { api } from "./api";
import { buildTrend, type TrendPoint } from "./trend";

/** The cache keys the location page uses, so a row here and the page it opens share one fetch. */
export const locationKey = (id: string) => ["location", id];
export const scansKey = (id: string) => ["location-scans", id];

/** Each location's score over time, oldest first. Empty until its scans have loaded. */
export function useTrends(locations: readonly Location[]): Map<string, TrendPoint[]> {
  const scans = useQueries({
    queries: locations.map((location) => ({
      queryKey: scansKey(location.id),
      queryFn: () => api.listScans(location.id),
    })),
  });
  return new Map(
    locations.map((location, index) => [
      location.id,
      buildTrend((scans[index]?.data as Scan[] | undefined) ?? []),
    ]),
  );
}

/** Each location's page data, for the rows of the locations table. Undefined while loading. */
export function useDetails(
  locations: readonly Location[],
): Map<string, LocationDetail | undefined> {
  const details = useQueries({
    queries: locations.map((location) => ({
      queryKey: locationKey(location.id),
      queryFn: () => api.getLocation(location.id),
    })),
  });
  return new Map(locations.map((location, index) => [location.id, details[index]?.data]));
}

export const placeOf = (location: { city: string; region: string | null }) =>
  [location.city, location.region].filter(Boolean).join(", ");
