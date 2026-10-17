import {
  allowanceFacts,
  describeLowered,
  type Organization,
  OrganizationInputSchema,
  PLAN_ASSISTANTS,
  type PlatformRole,
  SURFACE_LABELS,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { api } from "../lib/api";
import { billingWarning, formatDay, formatPrice, locationCount } from "../lib/billing";
import { useFormErrors } from "../lib/form";
import { listOf } from "../lib/format";
import { supabase } from "../lib/supabase";

interface AccountSettingsProps {
  organization: Organization;
  email: string | null;
  /** What the signed-in account is to the product itself. Null for nearly everyone. */
  platformRole: PlatformRole | null;
}

/**
 * The organization and the account behind it: its name, what its plan allows and how much of
 * that is used, the way to its billing and to everything it holds for its owner, and who is
 * signed in.
 */
export function AccountSettings({ organization, email, platformRole }: AccountSettingsProps) {
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const every = organization.scan_every_days;
  const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 300_000 });
  const plan = plans.data?.find((candidate) => candidate.key === organization.plan_key);
  const queryClient = useQueryClient();
  // Checkout sends the owner back here before its webhook has moved the plan, so keep asking
  // until the subscription shows.
  const returning = useSearchParams()[0].get("billing");
  const account = useQuery({
    queryKey: ["account", organization.id],
    queryFn: () => api.organizationAccount(organization.id),
    refetchInterval: (query) => {
      if (returning === "subscribed" && query.state.data?.billing?.subscribed === false)
        return 3000;
      // A change made a moment ago: the webhook moves the plan within a few seconds.
      return returning === "changed" && query.state.dataUpdateCount < 8 ? 3000 : false;
    },
  });
  const billing = account.data?.billing ?? null;
  // Billing is told to an owner alone. The operator and a test account take nothing away.
  const mayTakeItsData = billing !== null && !organization.is_test && platformRole === null;
  // The plan, its limits and what is paused all come from elsewhere, so read them again
  // whenever billing has been.
  // biome-ignore lint/correctness/useExhaustiveDependencies: billing being read again is the trigger
  useEffect(() => {
    if (account.dataUpdatedAt) queryClient.invalidateQueries({ queryKey: ["me"] });
  }, [account.dataUpdatedAt]);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="small muted">{organization.name}</p>
          <h1>Account settings</h1>
        </div>
      </div>

      <div className="settings">
        <RenameOrganization key={organization.id} organization={organization} />

        <div className="settings-side">
          <div className="card side-card">
            <h3 className="side-title">Your plan{plan ? `: ${plan.name}` : ""}</h3>
            <ul className="facts">
              <li>
                <span>Locations</span>
                <span>
                  {locations.data ? `${locations.data.length} of ` : ""}
                  {organization.max_locations}
                </span>
              </li>
              <li>
                <span>Prompts and keywords</span>
                <span>{organization.max_queries_per_location} per location</span>
              </li>
              <li>
                <span>Scheduled scans</span>
                <span>{every === 1 ? "Daily" : `Every ${every} days`}</span>
              </li>
              <li>
                <span>Scans run by hand</span>
                <span>
                  {account.data ? `${account.data.manual_scans_used} of ` : ""}
                  {organization.max_manual_scans_per_month} this month
                </span>
              </li>
              <li>
                <span>Report by email</span>
                <span>
                  {organization.emails_report ? "After each scheduled scan" : "Not included"}
                </span>
              </li>
              {allowanceFacts(
                organization.allowances,
                organization.max_locations,
                account.data?.allowance_use ?? null,
              ).map((fact) => (
                <li key={fact.key}>
                  <span>{fact.name}</span>
                  <span>{fact.value}</span>
                </li>
              ))}
              <li>
                <span>Checked on</span>
                <span>
                  {organization.surfaces
                    ? listOf(organization.surfaces.map((surface) => SURFACE_LABELS[surface]))
                    : "Everything that is set up"}
                </span>
              </li>
            </ul>
            {plan && plan.assistants < PLAN_ASSISTANTS.length && (
              <AssistantChooser key={organization.id} organization={organization} />
            )}
            {account.data?.limit_change && (
              <div role="status">
                <p>What this plan includes changes on {formatDay(account.data.limit_change.at)}:</p>
                <ul className="plan-facts">
                  {describeLowered(account.data.limit_change.lowered).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p>Nothing is deleted: what it no longer covers is paused, and stays readable.</p>
              </div>
            )}
            <Billing
              organization={organization}
              billing={billing}
              loaded={account.isSuccess}
              returning={returning}
              planName={(key) =>
                plans.data?.find((candidate) => candidate.key === key)?.name ?? key
              }
            />
            <ErrorNote error={account.error} />
          </div>

          {mayTakeItsData && <YourData organization={organization} />}

          <div className="card side-card">
            <h3 className="side-title">Signed in</h3>
            <p>{email ?? "No email on file"}</p>
            <button type="button" className="secondary" onClick={() => supabase?.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The owner's way to take everything the organization holds with them, at any time, and to close
 * the account.
 */
function YourData({ organization }: { organization: Organization }) {
  const download = useMutation({
    mutationFn: () => api.downloadEverything(organization.id),
    onSuccess: ({ file, name }) => {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      // Let the browser start saving it before the address goes.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
  return (
    <div className="card side-card">
      <h3 className="side-title">Your data</h3>
      <p>
        Download everything this organization holds: a spreadsheet for each list, and all of it in
        one file another tool can read.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={download.isPending}
        onClick={() => download.mutate()}
      >
        {download.isPending ? "Preparing the download" : "Download everything"}
      </button>
      <ErrorNote error={download.error} />
      <CloseAccount organization={organization} />
    </div>
  );
}

/**
 * Closing the account: what goes and what stays, said before anything is done, and the name typed
 * out to say the owner means it. The worker does the closing; the owner is signed out at once.
 */
function CloseAccount({ organization }: { organization: Organization }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const close = useMutation({
    mutationFn: () => api.closeAccount(organization.id, typed),
    onSuccess: async () => {
      await supabase?.auth.signOut();
      navigate("/closed", { replace: true });
    },
  });
  const named = typed.trim() === organization.name.trim();

  if (!open) {
    return (
      <button type="button" className="danger" onClick={() => setOpen(true)}>
        Close this account
      </button>
    );
  }
  return (
    <form
      className="closing"
      aria-label="Close this account"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (named) close.mutate();
      }}
    >
      <h4>Close this account</h4>
      <p>
        Closing deletes {organization.name} and everything in it, then your sign-in. It cannot be
        undone. Download everything first if you want to keep any of it.
      </p>
      <ul>
        <li>A paid plan is cancelled at once. The rest of this month is not refunded.</li>
        <li>
          Every connection is removed: Nearcited takes back its access to your WordPress site, and
          stops serving your answer subdomain.
        </li>
        <li>What Nearcited added to your WordPress site stays there until you remove it.</li>
        <li>Everyone else in the organization keeps their own sign-in and is sent a short note.</li>
        <li>
          Kept afterwards: what Nearcited paid its providers for your checks, with nothing to say
          whose they were; Nearcited's record of changes it made to your plan; Stripe's record of
          your payments; and for 30 days a one-way fingerprint of your email, so a new account made
          with it does not get another free first scan.
        </li>
      </ul>
      <Field
        label={`Type ${organization.name} to confirm`}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        autoComplete="off"
      />
      <div className="closing-actions">
        <button type="submit" className="danger" disabled={!named || close.isPending}>
          {close.isPending ? "Closing" : "Close the account"}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
      <ErrorNote error={close.error} />
    </form>
  );
}

interface BillingProps {
  organization: Organization;
  /** Null for anyone but the owner. */
  billing: NonNullable<Awaited<ReturnType<typeof api.organizationAccount>>["billing"]> | null;
  loaded: boolean;
  /** How the owner came back from checkout or from changing plan, if they just did. */
  returning: string | null;
  planName: (key: string) => string;
}

/**
 * The way to the plans and to the payment provider's account pages. Only the owner is offered
 * either: a member reads what the plan allows and is told who decides.
 */
function Billing({ organization, billing, loaded, returning, planName }: BillingProps) {
  const queryClient = useQueryClient();
  const portal = useMutation({
    mutationFn: () => api.billingPortal(organization.id),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const keep = useMutation({
    mutationFn: () => api.keepCurrentPlan(organization.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", organization.id] }),
  });

  if (!loaded) return null;
  if (organization.is_test) return <p>A test organization pays for nothing.</p>;
  if (!billing) return <p>The owner of this organization manages its plan and billing.</p>;

  const warning = billingWarning(billing.status);
  return (
    <>
      {returning === "subscribed" && (
        <p role="status">
          {billing.subscribed
            ? "Thank you. Your subscription has started."
            : "Thank you. Your plan will change here in a moment."}
        </p>
      )}
      {returning === "cancelled" && <p role="status">Checkout was cancelled. Nothing changed.</p>}
      {returning === "changed" && (
        <p role="status">Thank you. Your new plan shows here in a moment.</p>
      )}
      {billing.pending && (
        <>
          <p role="status">
            Changes to {planName(billing.pending.plan_key)} with{" "}
            {locationCount(billing.pending.locations)} on {formatDay(billing.pending.at)}, at{" "}
            {formatPrice(billing.pending.monthly_cents)} a month before tax. Until then nothing
            changes.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={keep.isPending}
            onClick={() => keep.mutate()}
          >
            {keep.isPending ? "Keeping" : "Keep my current plan"}
          </button>
          <ErrorNote error={keep.error} />
        </>
      )}
      {billing.subscribed && !billing.pending && billing.renews_at && (
        <p>
          Paying{billing.paying ? ` ${formatPrice(billing.paying.monthly_cents)} a month` : ""} for{" "}
          {billing.locations ? locationCount(billing.locations) : "this plan"}, before tax. Renews
          on {formatDay(billing.renews_at)}.
        </p>
      )}
      {billing.price_change && (
        <p role="status">
          The price of your plan is changing. From your first renewal on or after{" "}
          {formatDay(billing.price_change.at)} it will be{" "}
          {formatPrice(billing.price_change.monthly_cents)} a month before tax, for the locations
          you pay for now.
        </p>
      )}
      {warning && (
        <p className="error" role="alert">
          {warning}
        </p>
      )}
      {!billing.available && !billing.subscribed && (
        <p>Subscriptions are not available here yet.</p>
      )}
      <Link to="/pricing">
        {billing.subscribed ? "Change plan or locations" : "See plans and prices"}
      </Link>
      {billing.has_customer && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={portal.isPending}
            onClick={() => portal.mutate()}
          >
            {portal.isPending ? "Opening billing" : "Manage billing"}
          </button>
          <p>Payment method, invoices and cancelling are on Stripe's pages.</p>
          <ErrorNote error={portal.error} />
        </>
      )}
    </>
  );
}

function RenameOrganization({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(organization.name);
  const form$ = useFormErrors(OrganizationInputSchema, { name });
  const rename = useMutation({
    mutationFn: () => api.renameOrganization(organization.id, name),
    onSuccess: async (renamed) => {
      setName(renamed.name);
      // The sidebar and every page read the name from here.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) rename.mutate();
  }

  return (
    <form onSubmit={submit} className="card settings-main" noValidate>
      <div>
        <h2>Organization</h2>
        <p className="small muted">
          The business or agency your locations belong to. The name is only a label: changing it
          keeps every location, scan and report.
        </p>
      </div>
      <Field
        label="Organization name"
        required
        maxLength={120}
        value={name}
        error={form$.error("name")}
        onBlur={() => form$.touch("name")}
        onChange={(event) => {
          setName(event.target.value);
          rename.reset();
        }}
      />
      <button type="submit" disabled={rename.isPending || name.trim() === organization.name}>
        {rename.isPending ? "Saving" : "Save name"}
      </button>
      {rename.isSuccess && (
        <p className="small muted" role="status">
          Saved.
        </p>
      )}
      <ErrorNote error={rename.error} />
    </form>
  );
}

/**
 * For a plan that checks one assistant: which one. The choice can be changed at any time. What
 * the other assistant said before is kept, and the new one starts with no scans behind it.
 */
function AssistantChooser({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const current = PLAN_ASSISTANTS.find((surface) => organization.surfaces?.includes(surface));
  const choose = useMutation({
    mutationFn: (surface: (typeof PLAN_ASSISTANTS)[number]) =>
      api.chooseAssistants(organization.id, [surface]),
    // The sidebar, the location pages and this card all read the organization from here.
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be laid out as a pill group */}
      <div className="segmented" role="group" aria-label="Assistant to check">
        {PLAN_ASSISTANTS.map((surface) => (
          <button
            key={surface}
            type="button"
            aria-pressed={current === surface}
            disabled={choose.isPending}
            onClick={() => current !== surface && choose.mutate(surface)}
          >
            {SURFACE_LABELS[surface]}
          </button>
        ))}
      </div>
      <p>
        Your plan checks one assistant, and you choose which. If you switch, earlier results are
        kept and the new assistant's score starts from its first scan.
      </p>
      <ErrorNote error={choose.error} />
    </>
  );
}
