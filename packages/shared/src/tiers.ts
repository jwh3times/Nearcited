import {
  type Organization,
  PLAN_ASSISTANTS,
  type PlanAssistant,
  SURFACE_LABELS,
  type Surface,
  type Tier,
} from "./schemas";

/**
 * Stronger models: an owner pays to have an assistant asked with a stronger model than the one
 * the deployment checks everyone with (issue #86,
 * `docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`). Which model that is lives in
 * the tuning; which assistants are on it is set from the organization's subscription.
 */

/** The allowance that says a plan sells stronger models. A key of `ALLOWANCE_KINDS`. */
export const STRONGER_MODELS_ALLOWANCE = "stronger_models";

/** The assistants an organization is checked on, in a fixed order. Stronger is had only on these. */
export function checkedAssistants(organization: Pick<Organization, "surfaces">): PlanAssistant[] {
  return PLAN_ASSISTANTS.filter(
    (surface) => organization.surfaces === null || organization.surfaces.includes(surface),
  );
}

/**
 * The assistants an organization pays a stronger model on and is checked on, in a fixed order.
 * One it pays for and is not checked on is not asked at all.
 */
export function strongerSurfaces(
  organization: Pick<Organization, "surfaces" | "stronger_surfaces">,
): PlanAssistant[] {
  return checkedAssistants(organization).filter((surface) =>
    organization.stronger_surfaces.includes(surface),
  );
}

/** The tier an organization's scans are asked on, on one surface. */
export function tierOf(
  organization: Pick<Organization, "surfaces" | "stronger_surfaces">,
  surface: Surface,
): Tier {
  return strongerSurfaces(organization).some((stronger) => stronger === surface)
    ? "stronger"
    : "standard";
}

/** A surface's name, saying when it was asked on a stronger model: "ChatGPT (stronger)". */
export function surfaceWithTier(surface: Surface, tier: Tier = "standard"): string {
  return tier === "stronger" ? `${SURFACE_LABELS[surface]} (stronger)` : SURFACE_LABELS[surface];
}

/** One check, as far as its tier is concerned. A result kept before tiers is Standard. */
export interface TieredCheck {
  surface: Surface;
  tier?: Tier;
}

/** An assistant whose tier changed from one scan to the next. */
export interface TierChange {
  surface: Surface;
  tier: Tier;
}

/**
 * Where each scan changed an assistant's tier from the scan before it, scans oldest first. A scan
 * that did not ask a surface says nothing about it, so a surface is compared with the last scan
 * that asked it. The first scan to ask a surface changes nothing.
 */
export function tierChanges(scans: readonly (readonly TieredCheck[])[]): TierChange[][] {
  const last = new Map<Surface, Tier>();
  return scans.map((checks) => {
    const asked = new Map<Surface, Tier>();
    for (const check of checks) asked.set(check.surface, check.tier ?? "standard");
    const changed: TierChange[] = [];
    for (const [surface, tier] of asked) {
      const before = last.get(surface);
      if (before !== undefined && before !== tier) changed.push({ surface, tier });
      last.set(surface, tier);
    }
    return changed;
  });
}
