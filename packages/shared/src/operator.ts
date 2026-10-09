import type {
  AccountStage,
  AttentionItem,
  AttentionKind,
  Location,
  OperatorAccount,
  OperatorAccounts,
  OperatorOrganization,
  OperatorOverview,
  Organization,
  PlatformRole,
  Scan,
  SiteCheck,
  SiteCheckId,
} from "./schemas";
import { ACCOUNT_STAGES, ATTENTION_KINDS } from "./schemas";
import { SITE_CHECKS } from "./site";

/**
 * What the operator's first screen is worked out from: every organization's rows, as the operator
 * may read them. Nothing here decides who may see it; that is the database's job.
 */
export interface OperatorFacts {
  now: Date;
  /** The organizations the operator is a member of, to mark as their own. */
  operatorOrganizationIds: readonly string[];
  organizations: readonly Organization[];
  locations: readonly Location[];
  /** How many active prompts and keywords each location has, by location ID. */
  activePrompts: Readonly<Record<string, number>>;
  /** Recent scans of any location, in any order, each with the on-page check it made. */
  scans: readonly (Pick<
    Scan,
    "id" | "location_id" | "status" | "trigger" | "error" | "sample_data" | "created_at"
  > & { site_check: SiteCheck | null })[];
  audits: readonly {
    id: string;
    business_name: string;
    status: "queued" | "ready" | "failed";
    error: string | null;
    created_at: string;
  }[];
}

const HOUR = 3_600_000;
/** How far back a failure is still worth showing. Older than this, it is history. */
export const ATTENTION_WINDOW_MS = 7 * 24 * HOUR;
/** A scan in flight longer than this is not coming back by itself. */
const STUCK_AFTER_MS = 10 * 60 * 1000;
/** How late a scheduled scan may be before it counts as missed. */
const MISSED_GRACE_MS = 12 * HOUR;

/** The failed checks that mean an assistant's crawler gets nothing from the page. */
const BLOCKS_READING: ReadonlySet<SiteCheckId> = new Set([
  "reachable",
  "crawlers_allowed",
  "text_content",
]);

const newestFirst = (a: { created_at: string }, b: { created_at: string }) =>
  b.created_at.localeCompare(a.created_at);

/**
 * The operator's overview, without the part about the deployment, which the server adds.
 *
 * "Needs attention" is what is wrong now, not a history: a failure leaves the list when a later
 * scan succeeds, and everything leaves after a week. Test organizations are listed apart and are
 * never counted and never a problem.
 */
export function buildOperatorOverview(facts: OperatorFacts): Omit<OperatorOverview, "deployment"> {
  const now = facts.now.getTime();
  const within = (iso: string, ms: number) => now - Date.parse(iso) <= ms;

  const organizations = new Map(facts.organizations.map((org) => [org.id, org]));
  const locations = new Map(facts.locations.map((location) => [location.id, location]));
  const isReal = (organizationId: string) => organizations.get(organizationId)?.is_test === false;
  const realLocations = facts.locations.filter((location) => isReal(location.organization_id));

  const scansByLocation = new Map<string, OperatorFacts["scans"][number][]>();
  for (const scan of [...facts.scans].sort(newestFirst)) {
    const list = scansByLocation.get(scan.location_id) ?? [];
    list.push(scan);
    scansByLocation.set(scan.location_id, list);
  }
  const scansOf = (organizationId: string) =>
    facts.locations
      .filter((location) => location.organization_id === organizationId)
      .flatMap((location) => scansByLocation.get(location.id) ?? [])
      .sort(newestFirst);

  const attention: AttentionItem[] = [];
  const add = (
    kind: AttentionKind,
    detail: string,
    at: string | null,
    about: { organizationId?: string; locationId?: string; auditId?: string },
  ) => {
    const location = about.locationId ? locations.get(about.locationId) : undefined;
    const organizationId = about.organizationId ?? location?.organization_id ?? null;
    attention.push({
      kind,
      detail,
      at,
      organization_id: organizationId,
      organization_name: organizationId ? (organizations.get(organizationId)?.name ?? null) : null,
      location_id: location?.id ?? null,
      location_name: location?.name ?? null,
      audit_id: about.auditId ?? null,
    });
  };

  for (const location of realLocations) {
    const scans = scansByLocation.get(location.id) ?? [];
    const recent = scans.filter((scan) => within(scan.created_at, ATTENTION_WINDOW_MS));
    const lastGood = scans.find((scan) => scan.status === "succeeded");

    // The latest failure, unless a scan since then went through.
    const failed = recent.find((scan) => scan.status === "failed");
    if (failed && (!lastGood || lastGood.created_at < failed.created_at)) {
      add("scan_failed", failed.error ?? "No reason was recorded.", failed.created_at, {
        locationId: location.id,
      });
    }

    const stuck = scans.find(
      (scan) =>
        (scan.status === "queued" || scan.status === "running") &&
        !within(scan.created_at, STUCK_AFTER_MS),
    );
    if (stuck) {
      add(
        "scan_stuck",
        `A ${stuck.trigger} scan has been ${stuck.status} too long.`,
        stuck.created_at,
        {
          locationId: location.id,
        },
      );
    }

    const prompts = facts.activePrompts[location.id] ?? 0;
    if (prompts === 0) {
      add("no_prompts", "Has no active prompts or keywords, so it is never scanned.", null, {
        locationId: location.id,
      });
    }

    const organization = organizations.get(location.organization_id);
    if (organization && prompts > 0 && location.scan_frequency !== "off") {
      // The plan sets the pace; a location set to weekly asks for less.
      const days = Math.max(
        organization.scan_every_days,
        location.scan_frequency === "weekly" ? 7 : 1,
      );
      const since = location.last_scanned_at ?? location.created_at;
      if (!within(since, days * 24 * HOUR + MISSED_GRACE_MS)) {
        add(
          "scan_missed",
          location.last_scanned_at
            ? `Due every ${days === 1 ? "day" : `${days} days`}, and not scanned since then.`
            : "Has never been scanned.",
          since,
          { locationId: location.id },
        );
      }
    }

    // The website, as the latest scan that looked found it.
    const looked = recent.find((scan) => scan.status === "succeeded" && scan.site_check);
    const site = looked?.site_check;
    if (looked && site) {
      if (site.checks.length === 0) {
        add(
          "site_unloaded",
          site.status === null
            ? "Our fetch of its website got no answer."
            : `Our fetch of its website was answered with status ${site.status}.`,
          looked.created_at,
          { locationId: location.id },
        );
      } else {
        const blocking = site.checks.filter(
          (check) => !check.passed && BLOCKS_READING.has(check.id),
        );
        if (blocking.length > 0) {
          add(
            "site_blocked",
            blocking.map((check) => SITE_CHECKS[check.id].title).join(" "),
            looked.created_at,
            { locationId: location.id },
          );
        }
      }
    }
  }

  const rows: OperatorOrganization[] = facts.organizations.map((organization) => {
    const scans = scansOf(organization.id);
    const mine = facts.locations.filter((location) => location.organization_id === organization.id);
    const latest = scans[0];
    return {
      id: organization.id,
      name: organization.name,
      is_test: organization.is_test,
      is_yours: facts.operatorOrganizationIds.includes(organization.id),
      created_at: organization.created_at,
      locations: mine.length,
      max_locations: organization.max_locations,
      last_scan: latest ? { status: latest.status, at: latest.created_at } : null,
      failed_7d: scans.filter(
        (scan) => scan.status === "failed" && within(scan.created_at, ATTENTION_WINDOW_MS),
      ).length,
      scan_every_days: organization.scan_every_days,
      surfaces: organization.surfaces,
    };
  });

  for (const organization of facts.organizations.filter((org) => !org.is_test)) {
    // Its last two scans that ended, whichever locations they were of.
    const ended = scansOf(organization.id)
      .filter((scan) => scan.status === "failed" || scan.status === "succeeded")
      .slice(0, 2);
    const [latest] = ended;
    if (
      latest &&
      ended.length === 2 &&
      ended.every((scan) => scan.status === "failed") &&
      within(latest.created_at, ATTENTION_WINDOW_MS)
    ) {
      add("organization_failing", "Its last two scans both failed.", latest.created_at, {
        organizationId: organization.id,
      });
    }

    // A location with every prompt it may have cannot be given another. Having every location
    // the plan allows is not listed: the default plan allows one, so that is everyone.
    const allowed = organization.max_queries_per_location;
    for (const location of realLocations) {
      if (
        location.organization_id === organization.id &&
        (facts.activePrompts[location.id] ?? 0) >= allowed
      ) {
        add("at_limit", `Has used all ${allowed} of its prompts.`, null, {
          locationId: location.id,
        });
      }
    }
  }

  for (const audit of facts.audits) {
    if (audit.status === "failed" && within(audit.created_at, ATTENTION_WINDOW_MS)) {
      add(
        "audit_failed",
        `The audit for ${audit.business_name} failed: ${audit.error ?? "no reason was recorded."}`,
        audit.created_at,
        { auditId: audit.id },
      );
    }
  }

  attention.sort(
    (a, b) =>
      ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind) ||
      (b.at ?? "").localeCompare(a.at ?? ""),
  );

  const realScans = realLocations.flatMap((location) => scansByLocation.get(location.id) ?? []);
  const countOver = (ms: number) => {
    const scans = realScans.filter((scan) => within(scan.created_at, ms));
    return { total: scans.length, failed: scans.filter((scan) => scan.status === "failed").length };
  };
  // Trouble first: a last scan that failed, then the most failures, then by name.
  const troubleFirst = (a: OperatorOrganization, b: OperatorOrganization) =>
    Number(b.last_scan?.status === "failed") - Number(a.last_scan?.status === "failed") ||
    b.failed_7d - a.failed_7d ||
    a.name.localeCompare(b.name);

  return {
    totals: {
      organizations: rows.filter((row) => !row.is_test).length,
      locations: realLocations.length,
      scans_24h: countOver(24 * HOUR),
      scans_7d: countOver(ATTENTION_WINDOW_MS),
    },
    attention,
    organizations: rows.filter((row) => !row.is_test).sort(troubleFirst),
    test_organizations: rows.filter((row) => row.is_test).sort(troubleFirst),
  };
}

/** What the accounts list is worked out from. Only the operator may read any of it. */
export interface AccountFacts {
  now: Date;
  accounts: readonly {
    user_id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
  }[];
  /** Platform roles by account ID. An account not here has none. */
  roles: Readonly<Record<string, PlatformRole>>;
  memberships: readonly { user_id: string; organization_id: string }[];
  organizations: readonly Pick<Organization, "id" | "name">[];
  locations: readonly Pick<Location, "organization_id" | "last_scanned_at">[];
}

/**
 * Every account with how far it has got, newest first, and how many reached each stage. A stage
 * counts everyone who got at least that far. Test accounts are listed, so the operator can see
 * them, and are left out of the counts: they are not people trying the product.
 */
export function buildAccounts(facts: AccountFacts): OperatorAccounts {
  const now = facts.now.getTime();
  const organizations = new Map(facts.organizations.map((org) => [org.id, org.name]));
  const stageOf = (organizationId: string | undefined): AccountStage => {
    if (!organizationId) return "signed_up";
    const scans = facts.locations
      .filter((location) => location.organization_id === organizationId)
      .map((location) => location.last_scanned_at);
    if (scans.length === 0) return "organization";
    const scanned = scans.filter((at): at is string => at !== null);
    if (scanned.length === 0) return "location";
    return scanned.some((at) => now - Date.parse(at) <= ATTENTION_WINDOW_MS) ? "active" : "scanned";
  };

  const accounts: OperatorAccount[] = [...facts.accounts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((account) => {
      const organizationId = facts.memberships.find(
        (membership) => membership.user_id === account.user_id,
      )?.organization_id;
      return {
        ...account,
        platform_role: facts.roles[account.user_id] ?? null,
        organization_id: organizationId ?? null,
        organization_name: organizationId ? (organizations.get(organizationId) ?? null) : null,
        stage: stageOf(organizationId),
      };
    });

  const counted = accounts.filter((account) => account.platform_role !== "test");
  return {
    funnel: ACCOUNT_STAGES.map((stage, index) => ({
      stage,
      count: counted.filter((account) => ACCOUNT_STAGES.indexOf(account.stage) >= index).length,
    })),
    accounts,
  };
}
