import { PLAN_ASSISTANTS, type Plan, SURFACE_LABELS } from "@nearcited/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { LegalLinks } from "../components/LegalLinks";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import {
  formatPrice,
  monthlyCents,
  type PlanOffer,
  type PricingViewer,
  planOffer,
  rememberPlan,
} from "../lib/billing";
import { listOf } from "../lib/format";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/theme";

/**
 * The price list. Readable signed out, like the policies. What each plan's button does depends
 * on who is looking: a visitor signs in first, an owner goes to checkout, a subscriber to the
 * payment provider's account pages, and a member is told the owner decides.
 */
export function Pricing() {
  useTheme();
  useEffect(() => {
    const before = document.title;
    document.title = "Pricing | Nearcited";
    return () => {
      document.title = before;
    };
  }, []);

  const session = useSession();
  const [params] = useSearchParams();
  const chosen = params.get("plan");
  const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 300_000 });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: Boolean(session) });
  const organization = me.data?.organizations[0] ?? null;
  const account = useQuery({
    queryKey: ["account", organization?.id],
    queryFn: () => api.organizationAccount(organization?.id ?? ""),
    enabled: organization !== null,
  });

  // Until it is known who is looking, no plan offers anything: a button that changed under the
  // pointer would be worse than one that arrived a moment later.
  const known = session === null || me.isSuccess;
  const viewer: PricingViewer = session ? { organization, account: account.data ?? null } : null;

  return (
    <>
      <header className="audit-head">
        <Logo plain />
        {session ? <Link to="/">Back to your locations</Link> : <Link to="/">Sign in</Link>}
      </header>
      <main className="pricing">
        <h1>Pricing</h1>
        <p className="lede">
          Every plan tracks how often AI assistants name your business. A bigger plan tracks more
          locations and more prompts, more often. Prices are a month, before tax. Change or cancel
          at any time.
        </p>
        <ErrorNote error={plans.error ?? me.error ?? account.error} />
        {plans.isPending && <p className="status">Loading</p>}
        <div className="plan-grid">
          {plans.data
            ?.filter((plan) => plan.on_sale)
            .map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                chosen={plan.key === chosen}
                offer={known ? planOffer(plan, viewer) : "none"}
                organizationId={organization?.id ?? null}
                organizationName={organization?.name ?? null}
              />
            ))}
        </div>
      </main>
      <footer className="legal-foot">
        <LegalLinks />
      </footer>
    </>
  );
}

interface PlanCardProps {
  plan: Plan;
  /** True for the plan a visitor picked before signing in. */
  chosen: boolean;
  offer: PlanOffer;
  organizationId: string | null;
  organizationName: string | null;
}

function PlanCard({ plan, chosen, offer, organizationId, organizationName }: PlanCardProps) {
  const navigate = useNavigate();
  const [locations, setLocations] = useState(plan.included_locations);
  const sellsMore = plan.extra_location_price_cents !== null;
  const count = Number.isInteger(locations)
    ? Math.min(1000, Math.max(plan.included_locations, locations))
    : plan.included_locations;

  // Both answer with an address at the payment provider, and the browser goes there.
  const leave = useMutation({
    mutationFn: (to: "checkout" | "portal") =>
      to === "checkout"
        ? api.checkout(organizationId ?? "", { plan_key: plan.key, locations: count })
        : api.billingPortal(organizationId ?? ""),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  const every = plan.scan_every_days;
  const assistants = PLAN_ASSISTANTS.map((surface) => SURFACE_LABELS[surface]);
  return (
    <section
      className={chosen ? "card plan-card chosen" : "card plan-card"}
      aria-label={`${plan.name} plan`}
    >
      <h2>{plan.name}</h2>
      <p className="plan-price">
        <span className="plan-amount">
          {formatPrice(offer === "subscribe" ? monthlyCents(plan, count) : plan.price_cents)}
        </span>
        <span className="muted"> a month</span>
      </p>
      <ul className="plan-facts">
        <li>
          {plan.included_locations === 1 ? "1 location" : `${plan.included_locations} locations`}
          {plan.extra_location_price_cents !== null &&
            `, then ${formatPrice(plan.extra_location_price_cents)} for each one more`}
        </li>
        <li>{plan.max_queries_per_location} prompts and keywords for each location</li>
        <li>
          {plan.assistants >= assistants.length
            ? `Checked on ${listOf(assistants)}`
            : `Checked on one assistant: your choice of ${assistants.join(" or ")}`}
        </li>
        <li>{every === 1 ? "Scanned every day" : `Scanned every ${every} days`}</li>
        <li>
          {plan.max_manual_scans_per_month === 0
            ? "No extra scans on demand"
            : `${plan.max_manual_scans_per_month} extra scans on demand a month`}
        </li>
        <li>{plan.emails_report ? "A report by email after each scan" : "No emailed report"}</li>
      </ul>

      <div className="plan-action">
        {offer === "sign-in" && (
          <button
            type="button"
            className={plan.price_cents === 0 ? "secondary" : undefined}
            onClick={() => {
              rememberPlan(plan.key);
              navigate("/");
            }}
          >
            {plan.price_cents === 0 ? "Start free" : `Choose ${plan.name}`}
          </button>
        )}
        {offer === "finish-setup" && <Link to="/">Finish setting up your account first</Link>}
        {offer === "current" && <p className="plan-current">Your plan</p>}
        {offer === "subscribe" && (
          <>
            {sellsMore && (
              <label className="plan-locations">
                Locations
                <input
                  type="number"
                  inputMode="numeric"
                  min={plan.included_locations}
                  max={1000}
                  value={Number.isNaN(locations) ? "" : locations}
                  onChange={(event) => setLocations(event.target.valueAsNumber)}
                />
              </label>
            )}
            <button
              type="button"
              disabled={leave.isPending}
              onClick={() => leave.mutate("checkout")}
            >
              {leave.isPending ? "Opening checkout" : `Subscribe to ${plan.name}`}
            </button>
            <p className="small muted">You pay on Stripe's page. Tax is added there.</p>
          </>
        )}
        {offer === "manage" && (
          <button
            type="button"
            className="secondary"
            disabled={leave.isPending}
            onClick={() => leave.mutate("portal")}
          >
            {leave.isPending
              ? "Opening billing"
              : plan.price_cents === 0
                ? "Cancel in billing"
                : "Change plan in billing"}
          </button>
        )}
        {offer === "owner-only" && (
          <p className="small muted">The owner of {organizationName} chooses its plan.</p>
        )}
        {offer === "unavailable" && (
          <p className="small muted">Subscriptions are not available here yet.</p>
        )}
        <ErrorNote error={leave.error} />
      </div>
    </section>
  );
}
