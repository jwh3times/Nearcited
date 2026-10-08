import type { Action } from "@nearcited/shared";
import { useState } from "react";

const key = (locationId: string) => `nearcited:done:${locationId}`;

/** A step is remembered by what it says, so a step that changes comes back unticked. */
export const stepKey = (action: Action) => `${action.id}:${action.title}`;

function read(locationId: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key(locationId)) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Which steps of a location's plan the reader has ticked off. Kept in this browser only: it is a
 * note to oneself, not something a scan can confirm, so it is not sent anywhere.
 */
export function useDone(locationId: string): [ReadonlySet<string>, (step: string) => void] {
  const [done, setDone] = useState(() => ({ locationId, steps: read(locationId) }));
  // A different location has its own ticks.
  const steps = done.locationId === locationId ? done.steps : read(locationId);

  const toggle = (step: string) => {
    const next = steps.includes(step) ? steps.filter((item) => item !== step) : [...steps, step];
    try {
      window.localStorage.setItem(key(locationId), JSON.stringify(next));
    } catch {}
    setDone({ locationId, steps: next });
  };
  return [new Set(steps), toggle];
}
