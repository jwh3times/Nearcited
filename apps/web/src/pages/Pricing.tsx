import {
  PLAN_ASSISTANTS,
  type Plan,
  SURFACE_LABELS,
  type SubscriptionChange,
} from "@nearcited/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { LegalLinks } from "../components/LegalLinks";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import {
  formatDay,
  formatPrice,
  locationCount,
  monthlyCents,
  type PlanOffer,
  type PricingViewer,
  planOffer,
  rememberPlan,
} from "../lib/billing";
import { listOf } from "../lib/format";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/theme";

/** The most locations checkout takes, as the API has it. */
const MOST_LOCATIONS = 1000;

/**
 * The price list. Readable signed out, like the policies. What each plan's button does depends
 * on who is looking: a visitor signs in first, an owner goes to checkout, a subscriber changes
 * plan or the locations they pay for here, and a member is told the owner decides.
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
  const billing = account.data?.billing ?? null;
  const pending = billing?.pending ?? null;
  const pendingPlan = plans.data?.find((plan) => plan.key === pending?.plan_key);

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
        {pending && (
          <p className="card notice" role="status">
            Your plan changes to {pendingPlan?.name ?? pending.plan_key} with{" "}
            {locationCount(pending.locations)} on {formatDay(pending.at)}. Choosing something else
            here replaces that. To keep what you have now, go to{" "}
            <Link to="/settings">Account settings</Link>.
          </p>
        )}
        <ErrorNote error={plans.error ?? me.error ?? account.error} />
        {plans.isPending && <p className="status">Loading</p>}
        <div className="plan-grid">
          {plans.data
            ?.filter((plan) => plan.on_sale)
            .map((plan) => (
              <PlanCard
                // What is paid for arrives after the plans, and the stepper starts from it.
                key={`${plan.key}:${billing?.locations ?? ""}`}
                plan={plan}
                chosen={plan.key === chosen}
                offer={known ? planOffer(plan, viewer) : "none"}
                current={organization?.plan_key === plan.key}
                paidLocations={billing?.locations ?? null}
                paying={billing?.paying ?? null}
                renewsAt={billing?.renews_at ?? null}
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
  /** True for the plan the organization is on. */
  current: boolean;
  /** How many locations a subscriber pays for now. Null for anyone else. */
  paidLocations: number | null;
  /** The prices a subscriber is billed at, which their own plan's card shows. */
  paying: Pick<Plan, "price_cents" | "extra_location_price_cents"> | null;
  /** When a subscriber's paid period ends. */
  renewsAt: string | null;
  organizationId: string | null;
  organizationName: string | null;
}

function PlanCard({
  plan,
  chosen,
  offer,
  current,
  paidLocations,
  paying,
  renewsAt,
  organizationId,
  organizationName,
}: PlanCardProps) {
  const navigate = useNavigate();
  const least = plan.included_locations;
  const sellsMore = plan.extra_location_price_cents !== null;
  // A subscriber starts from what they pay for, as far as this plan can take it.
  const start = sellsMore ? Math.max(least, paidLocations ?? 0) : least;
  // What is typed, kept as text so the field can be emptied on the way to another number.
  const [typed, setTyped] = useState(String(start));
  const count = /^\d+$/.test(typed)
    ? Math.min(sellsMore ? MOST_LOCATIONS : least, Math.max(least, Number(typed)))
    : least;
  const input = { plan_key: plan.key, locations: count };
  const picking = offer === "subscribe" || offer === "change";
  // On their own plan a subscriber goes on paying what they joined at, whatever it sells for now.
  const prices = current && paying ? paying : plan;
  const unchanged = current && count === paidLocations;

  // Both answer with an address at the payment provider, and the browser goes there.
  const leave = useMutation({
    mutationFn: (to: "checkout" | "portal") =>
      to === "checkout"
        ? api.checkout(organizationId ?? "", input)
        : api.billingPortal(organizationId ?? ""),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  // A subscriber reads what a change comes to before making it.
  const preview = useMutation({
    mutationFn: () => api.previewSubscriptionChange(organizationId ?? "", input),
  });
  const change = useMutation({
    mutationFn: () => api.changeSubscription(organizationId ?? "", input),
    onSuccess: (made) =>
      navigate(`/settings?billing=${made.kind === "upgrade" ? "changed" : "scheduled"}`),
  });

  const every = plan.scan_every_days;
  const assistants = PLAN_ASSISTANTS.map((surface) => SURFACE_LABELS[surface]);
  return (
    <section
      className={chosen || current ? "card plan-card chosen" : "card plan-card"}
      aria-label={`${plan.name} plan`}
    >
      <h2>
        {plan.name}
        {current && <span className="plan-current">Your plan</span>}
      </h2>
      <p className="plan-price">
        <span className="plan-amount">
          {formatPrice(picking ? monthlyCents(plan, count, prices) : prices.price_cents)}
        </span>
        <span className="muted"> a month</span>
      </p>
      <ul className="plan-facts">
        <li>
          {locationCount(plan.included_locations)}
          {prices.extra_location_price_cents !== null &&
            `, then ${formatPrice(prices.extra_location_price_cents)} for each one more`}
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
            className={plan.price_cents === 0 ? "plan-button secondary" : "plan-button"}
            onClick={() => {
              rememberPlan(plan.key);
              navigate("/");
            }}
          >
            {plan.price_cents === 0 ? "Start free" : `Choose ${plan.name}`}
          </button>
        )}
        {offer === "finish-setup" && <Link to="/">Finish setting up your account first</Link>}

        {picking && sellsMore && !preview.data && (
          <div className="plan-locations">
            <span id={`${plan.key}-locations`}>Locations</span>
            <div className="count-stepper">
              <button
                type="button"
                aria-label="One location fewer"
                disabled={count <= least}
                onClick={() => setTyped(String(count - 1))}
              >
                −
              </button>
              <input
                inputMode="numeric"
                aria-labelledby={`${plan.key}-locations`}
                value={typed}
                onChange={(event) => setTyped(event.target.value.replace(/\D/g, "").slice(0, 4))}
                // Leaving the field settles it on what will be charged for.
                onBlur={() => setTyped(String(count))}
              />
              <button
                type="button"
                aria-label="One location more"
                disabled={count >= MOST_LOCATIONS}
                onClick={() => setTyped(String(count + 1))}
              >
                +
              </button>
            </div>
          </div>
        )}

        {offer === "subscribe" && (
          <>
            <button
              type="button"
              className="plan-button"
              aria-label={`Subscribe to ${plan.name}`}
              disabled={leave.isPending}
              onClick={() => leave.mutate("checkout")}
            >
              {leave.isPending ? "Opening checkout" : "Subscribe"}
            </button>
            <p className="small muted">You pay on Stripe's page. Tax is added there.</p>
          </>
        )}

        {offer === "change" && !preview.data && (
          <button
            type="button"
            className={current ? "plan-button secondary" : "plan-button"}
            aria-label={current ? `Update locations on ${plan.name}` : `Switch to ${plan.name}`}
            disabled={unchanged || preview.isPending}
            onClick={() => preview.mutate()}
          >
            {preview.isPending ? "Working it out" : current ? "Update locations" : "Switch"}
          </button>
        )}
        {offer === "change" && preview.data && (
          <ConfirmChange
            plan={plan}
            change={preview.data}
            renewsAt={renewsAt}
            confirming={change.isPending}
            onConfirm={() => change.mutate()}
            onBack={() => {
              preview.reset();
              change.reset();
            }}
          />
        )}

        {offer === "manage" && (
          <>
            <button
              type="button"
              className="plan-button secondary"
              disabled={leave.isPending}
              onClick={() => leave.mutate("portal")}
            >
              {leave.isPending ? "Opening billing" : "Cancel subscription"}
            </button>
            <p className="small muted">
              You cancel on Stripe's page, and keep your plan until the period you paid for ends.
            </p>
          </>
        )}
        {offer === "owner-only" && (
          <p className="small muted">The owner of {organizationName} chooses its plan.</p>
        )}
        {offer === "unavailable" && (
          <p className="small muted">Subscriptions are not available here yet.</p>
        )}
        <ErrorNote error={leave.error ?? preview.error ?? change.error} />
      </div>
    </section>
  );
}

interface ConfirmChangeProps {
  plan: Plan;
  change: SubscriptionChange;
  renewsAt: string | null;
  confirming: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/** What a change comes to, said before it is made: what is charged, and when it takes effect. */
function ConfirmChange({
  plan,
  change,
  renewsAt,
  confirming,
  onConfirm,
  onBack,
}: ConfirmChangeProps) {
  const monthly = `${formatPrice(change.monthly_cents)} a month before tax`;
  const what = `${plan.name} with ${locationCount(change.locations)}`;
  return (
    <div className="plan-confirm">
      {change.kind === "upgrade" ? (
        <p>
          <strong>{what}, starting now.</strong> Your card is charged{" "}
          {formatPrice(Math.max(0, change.due_now_cents ?? 0))} today for the rest of this period,
          tax included. {renewsAt ? `From ${formatDay(renewsAt)} it is` : "After that it is"}{" "}
          {monthly}.
        </p>
      ) : (
        <p>
          <strong>
            {what}, from {change.effective_at ? formatDay(change.effective_at) : "your next period"}
            .
          </strong>{" "}
          Nothing is charged now and you keep your current plan until then. After that it is{" "}
          {monthly}. Anything the smaller plan does not cover is paused, not deleted.
        </p>
      )}
      <button type="button" className="plan-button" disabled={confirming} onClick={onConfirm}>
        {confirming
          ? "Changing"
          : change.kind === "upgrade"
            ? "Confirm and pay"
            : "Confirm the change"}
      </button>
      <button
        type="button"
        className="plan-button secondary"
        disabled={confirming}
        onClick={onBack}
      >
        Back
      </button>
    </div>
  );
}
