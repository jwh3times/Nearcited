import {
  describeLowered,
  type LoweredLimits,
  type OperatorPlan,
  type PlanImpact,
  PlanPricesInputSchema,
  type PlanSettings,
  PlanSettingsSchema,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { centsToDollars, dollarsToCents, formatDay, formatPrice } from "../lib/billing";
import { useFormErrors } from "../lib/form";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";
import { Labelled } from "./Labelled";

const NUMBERS: { name: NumberField; label: string; hint: string }[] = [
  {
    name: "max_queries_per_location",
    label: "Prompts and keywords per location",
    hint: "Retired ones do not count.",
  },
  {
    name: "assistants",
    label: "Assistants checked",
    hint: "1 lets the owner choose which; 2 is both.",
  },
  { name: "scan_every_days", label: "Days between scheduled scans", hint: "1 is daily." },
  {
    name: "max_manual_scans_per_month",
    label: "Scans run by hand per month",
    hint: "Across the organization, in a calendar month (UTC).",
  },
];
type NumberField =
  | "max_queries_per_location"
  | "assistants"
  | "scan_every_days"
  | "max_manual_scans_per_month";

/** Fewer prompts, fewer assistants, slower scans, fewer scans by hand, or no report. */
function lowers(plan: OperatorPlan, to: PlanSettings): boolean {
  return (
    to.max_queries_per_location < plan.max_queries_per_location ||
    to.assistants < plan.assistants ||
    to.scan_every_days > plan.scan_every_days ||
    to.max_manual_scans_per_month < plan.max_manual_scans_per_month ||
    (plan.emails_report && !to.emails_report)
  );
}

/** The plan every new organization is put on. */
const FREE_PLAN = "free";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What is on sale and who is on it, and the form that changes what a plan allows. Prices are
 * shown and not changed here: a price is charged through the payment provider.
 */
export function OperatorPlans() {
  const plans = useQuery({ queryKey: ["operator-plans"], queryFn: api.operatorPlans });
  const [editing, setEditing] = useState<string | null>(null);
  const columns = "minmax(9rem,1.2fr) 7rem 7.5rem 6.5rem 7.5rem 5rem";

  return (
    <section className="stack">
      <div className="section-head">
        <h2>Plans</h2>
        <span className="small">
          Who is on what, without test organizations. A change to a plan's limits reaches everyone
          on it at once.
        </span>
      </div>
      {plans.isPending && <p className="status">Loading</p>}
      <ErrorNote error={plans.error} />
      {plans.data && (
        <div className="gtable-scroll">
          <div className="gtable stacks" style={{ "--cols": columns, "--min": "44rem" } as never}>
            <div className="gtable-head">
              <span>Plan</span>
              <span>Price</span>
              <span>Organizations</span>
              <span>Subscribers</span>
              <span>A month</span>
              <span />
            </div>
            {plans.data.map((plan) => (
              <div key={plan.key} className="gtable-row">
                <span className="stack-tight">
                  <span className="loc-name ellipsis">{plan.name}</span>
                  <span className="small muted">
                    {plan.on_sale ? "On sale" : "Off sale"} · {plan.max_queries_per_location}{" "}
                    prompts ·{" "}
                    {plan.scan_every_days === 1 ? "daily" : `every ${plan.scan_every_days} days`}
                  </span>
                </span>
                <Labelled label="Price">
                  <span className="mono">{formatPrice(plan.price_cents)}</span>
                </Labelled>
                <Labelled label="Organizations">
                  <span className="mono">{plan.organizations}</span>
                </Labelled>
                <Labelled label="Subscribers">
                  <span className={plan.subscribers > 0 ? "mono" : "mono muted"}>
                    {plan.subscribers}
                  </span>
                </Labelled>
                <Labelled label="A month">
                  <span className={plan.monthly_cents > 0 ? "mono" : "mono muted"}>
                    {formatPrice(plan.monthly_cents)}
                  </span>
                </Labelled>
                <button
                  type="button"
                  className="link"
                  aria-label={`Edit ${plan.name}`}
                  aria-expanded={editing === plan.key}
                  onClick={() => setEditing(editing === plan.key ? null : plan.key)}
                >
                  {editing === plan.key ? "Close" : "Edit"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {plans.data
        ?.filter((plan) => plan.key === editing)
        .map((plan) => (
          <div key={plan.key} className="stack">
            <PlanEditor plan={plan} onDone={() => setEditing(null)} />
            {plan.price_cents > 0 && (
              // Remade when the prices change, so the fields start from what was just saved.
              <PriceEditor
                key={`${plan.price_cents}:${plan.extra_location_price_cents}`}
                plan={plan}
              />
            )}
          </div>
        ))}
    </section>
  );
}

function PlanEditor({ plan, onDone }: { plan: OperatorPlan; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(plan.name);
  const [onSale, setOnSale] = useState(plan.on_sale);
  const [report, setReport] = useState(plan.emails_report);
  const [text, setText] = useState(
    () =>
      Object.fromEntries(NUMBERS.map((field) => [field.name, String(plan[field.name])])) as Record<
        NumberField,
        string
      >,
  );
  // An empty field is not zero: it is nothing, and the schema says so.
  const number = (field: NumberField) =>
    text[field].trim() === "" ? Number.NaN : Number(text[field]);
  const settings: PlanSettings = {
    name,
    on_sale: onSale,
    emails_report: report,
    max_queries_per_location: number("max_queries_per_location"),
    assistants: number("assistants"),
    scan_every_days: number("scan_every_days"),
    max_manual_scans_per_month: number("max_manual_scans_per_month"),
  };
  const form$ = useFormErrors(PlanSettingsSchema, settings);
  const unchanged =
    name.trim() === plan.name &&
    onSale === plan.on_sale &&
    report === plan.emails_report &&
    NUMBERS.every((field) => settings[field.name] === plan[field.name]);

  // Lowering a limit takes something from the organizations on the plan, so it is asked first
  // who that is, and saved only once the operator has read the answer.
  const [impact, setImpact] = useState<PlanImpact | null>(null);
  // Where subscribers pay for the plan, a reduction is announced for a day and made then.
  const needsNotice = plan.key !== FREE_PLAN && plan.subscribers > 0 && lowers(plan, settings);
  const [reduceOn, setReduceOn] = useState(dayFrom(31));
  // What an open announcement is going to lower stays as it is until the day.
  const held = (field: keyof LoweredLimits) => plan.limit_change?.lowered[field] !== undefined;
  const save = useMutation({
    mutationFn: async (confirmed: boolean) => {
      if (!confirmed && lowers(plan, settings) && plan.organizations > 0) {
        setImpact(await api.planImpact(plan.key, settings));
        return null;
      }
      return api.setPlan(plan.key, needsNotice ? { ...settings, reduce_on: reduceOn } : settings);
    },
    onSuccess: async (saved) => {
      if (!saved) return;
      setImpact(null);
      // The plans, and every organization's limits on the lists above, have changed.
      await queryClient.invalidateQueries({ queryKey: ["operator-plans"] });
      await queryClient.invalidateQueries({ queryKey: ["operator-overview"] });
      await queryClient.invalidateQueries({ queryKey: ["plans"] });
      onDone();
    },
  });
  const changed = () => {
    setImpact(null);
    save.reset();
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) save.mutate(impact !== null);
  }

  return (
    <form
      onSubmit={submit}
      className="card settings-main"
      noValidate
      aria-label={`Edit ${plan.name}`}
    >
      <div>
        <h3>{plan.name}</h3>
        <p className="small muted">
          {count(plan.organizations, "organization is", "organizations are")} on this plan and take
          any change here at once. The price ({formatPrice(plan.price_cents)} a month) and the
          locations it includes ({plan.included_locations}) are not changed here.
        </p>
      </div>
      <Field
        label="Name"
        required
        maxLength={40}
        value={name}
        error={form$.error("name")}
        onBlur={() => form$.touch("name")}
        onChange={(event) => {
          setName(event.target.value);
          changed();
        }}
      />
      {NUMBERS.map((field) => (
        <Field
          key={field.name}
          label={field.label}
          hint={field.hint}
          inputMode="numeric"
          required
          disabled={held(field.name)}
          value={text[field.name]}
          error={form$.error(field.name)}
          onBlur={() => form$.touch(field.name)}
          onChange={(event) => {
            setText({ ...text, [field.name]: event.target.value });
            changed();
          }}
        />
      ))}
      <label className="check">
        <input
          type="checkbox"
          checked={report}
          disabled={held("emails_report")}
          onChange={(event) => {
            setReport(event.target.checked);
            changed();
          }}
        />
        A report is emailed after each scheduled scan
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={onSale}
          // Every new organization starts on the free plan, so it is always offered.
          disabled={plan.key === FREE_PLAN}
          onChange={(event) => {
            setOnSale(event.target.checked);
            changed();
          }}
        />
        {plan.key === FREE_PLAN
          ? "On sale. The free plan cannot be taken off sale: every new organization starts on it"
          : "On sale: shown on the price list and open to new subscribers"}
      </label>

      {impact && !needsNotice && (
        <p className="error" role="alert">
          This lowers what the plan allows for{" "}
          {count(impact.organizations, "organization", "organizations")}, starting now.{" "}
          {impact.prompts_set_aside > 0
            ? `${count(impact.prompts_set_aside, "of them has", "of them have")} more prompts than the new limit, and the newest of those are set aside. `
            : "None of them has more prompts than the new limit. "}
          Nothing is deleted.{" "}
          {plan.key === FREE_PLAN ? "Each of them is emailed today, saying what changed. " : ""}
          Save again to go ahead.
        </p>
      )}
      {impact && needsNotice && (
        <>
          <p className="error" role="alert">
            {count(plan.subscribers, "subscriber pays", "subscribers pay")} for this plan, so what
            it lowers cannot change today. Choose the day: at least 30 days from now. Everyone on
            the plan, {count(impact.organizations, "organization", "organizations")}, is emailed now
            and again a week before, and the reduction is made on the day.{" "}
            {impact.prompts_set_aside > 0
              ? `${count(impact.prompts_set_aside, "of them has", "of them have")} more prompts than the new limit. `
              : ""}
            Anything you raised, and the name, are saved at once.
          </p>
          <Field
            label="Reduce from"
            type="date"
            min={dayFrom(30)}
            value={reduceOn}
            onChange={(event) => {
              setReduceOn(event.target.value);
              save.reset();
            }}
          />
        </>
      )}
      <div className="button-row">
        <button type="submit" disabled={save.isPending || unchanged}>
          {save.isPending
            ? "Saving"
            : !impact
              ? "Save plan"
              : needsNotice
                ? "Announce the reduction, and send the emails"
                : "Save, and lower it for them"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNote error={save.error} />
      {plan.limit_change && (
        <>
          <hr className="divider" />
          <Reduction plan={plan} change={plan.limit_change} />
        </>
      )}
    </form>
  );
}

/** A reduction that has been announced: what goes down, when, who has been told, and the way out. */
function Reduction({
  plan,
  change,
}: {
  plan: OperatorPlan;
  change: NonNullable<OperatorPlan["limit_change"]>;
}) {
  const queryClient = useQueryClient();
  const callOff = useMutation({
    mutationFn: () => api.callOffLimitChange(plan.key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["operator-plans"] }),
  });
  const begun = Date.parse(change.effective_at) <= Date.now();
  return (
    <div className="stack-tight">
      <h3>Reduction announced</h3>
      <p className="small muted">
        On {formatDay(change.effective_at)} this plan changes for everyone on it. Until then these
        stay as they are:
      </p>
      <ul className="plan-facts">
        {describeLowered(change.lowered).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="small muted">
        {count(change.told, "organization", "organizations")} told so far. A reminder goes out a
        week before.
      </p>
      {change.not_told.length > 0 && (
        <p className="error" role="alert">
          Not told yet: {change.not_told.join(", ")}. The reduction reaches them on the day all the
          same, so if this is still here after a few minutes, write to them yourself.
        </p>
      )}
      {!begun && (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={callOff.isPending}
            onClick={() => callOff.mutate()}
          >
            {callOff.isPending
              ? "Calling it off"
              : "Call off the reduction, and email everyone who was told"}
          </button>
        </div>
      )}
      <ErrorNote error={callOff.error} />
    </div>
  );
}

/**
 * What a plan is sold at. Typed in dollars. A new price is for new subscribers: whoever already
 * subscribes goes on paying what they were.
 */
function PriceEditor({ plan }: { plan: OperatorPlan }) {
  const queryClient = useQueryClient();
  const [price, setPrice] = useState(centsToDollars(plan.price_cents));
  const [extra, setExtra] = useState(
    plan.extra_location_price_cents === null ? "" : centsToDollars(plan.extra_location_price_cents),
  );
  const prices = {
    price_cents: dollarsToCents(price),
    // Left empty, the plan sells no more locations than it includes.
    extra_location_price_cents: extra.trim() === "" ? null : dollarsToCents(extra),
  };
  const form$ = useFormErrors(PlanPricesInputSchema, prices);
  const unchanged =
    prices.price_cents === plan.price_cents &&
    prices.extra_location_price_cents === plan.extra_location_price_cents;
  const save = useMutation({
    mutationFn: () => api.setPlanPrices(plan.key, prices),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-plans"] });
      // The price list reads the same rows.
      await queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  // What was announced is what is charged, so the prices stay put while a change is open.
  const held = plan.price_change !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) save.mutate();
  }

  return (
    <form
      onSubmit={submit}
      className="card settings-main"
      noValidate
      aria-label={`Prices of ${plan.name}`}
    >
      <div>
        <h3>{plan.name}: prices</h3>
        <p className="small muted">
          In dollars a month, before tax. A new price is charged to new subscribers from the moment
          it is saved.{" "}
          {plan.subscribers > 0
            ? `${count(plan.subscribers, "subscriber goes", "subscribers go")} on paying what they pay now.`
            : "Nobody subscribes to this plan yet."}
        </p>
      </div>
      <Field
        label="Price a month"
        inputMode="decimal"
        required
        disabled={held}
        value={price}
        error={form$.error("price_cents")}
        onBlur={() => form$.touch("price_cents")}
        onChange={(event) => {
          setPrice(event.target.value);
          save.reset();
        }}
      />
      <Field
        label="Each extra location a month"
        hint={
          held
            ? "Held as announced until the price change below is finished or called off."
            : "Leave empty to sell no more locations than the plan includes."
        }
        inputMode="decimal"
        disabled={held}
        value={extra}
        error={form$.error("extra_location_price_cents")}
        onBlur={() => form$.touch("extra_location_price_cents")}
        onChange={(event) => {
          setExtra(event.target.value);
          save.reset();
        }}
      />
      <div className="button-row">
        <button type="submit" disabled={save.isPending || unchanged || held}>
          {save.isPending
            ? "Saving"
            : unchanged || Number.isNaN(prices.price_cents)
              ? "Save prices"
              : `Sell at ${formatPrice(prices.price_cents)} from now`}
        </button>
      </div>
      {save.isSuccess && (
        <p className="small muted" role="status">
          Saved. New subscribers pay this from now.
        </p>
      )}
      <ErrorNote error={save.error} />
      {(plan.price_change || plan.subscribers > 0) && (
        <>
          <hr className="divider" />
          <PriceChange plan={plan} />
        </>
      )}
    </form>
  );
}

const DAY_MS = 86_400_000;
/** A day as a date field holds it, `days` from today. */
const dayFrom = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Moving the subscribers a plan already has to its present prices: announce a day, and each is
 * moved at its first renewal on or after it. Announcing emails their owners, so it is asked
 * twice. Until the day comes it can be called off, which emails them again.
 */
function PriceChange({ plan }: { plan: OperatorPlan }) {
  const queryClient = useQueryClient();
  const [day, setDay] = useState(dayFrom(31));
  const [asked, setAsked] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operator-plans"] });
  const announce = useMutation({
    mutationFn: () => api.announcePriceChange(plan.key, day),
    onSuccess: refresh,
    onSettled: () => setAsked(false),
  });
  const callOff = useMutation({
    mutationFn: () => api.callOffPriceChange(plan.key),
    onSuccess: refresh,
  });
  const open = plan.price_change;

  if (open) {
    const begun = Date.parse(open.effective_at) <= Date.now();
    return (
      <div className="stack-tight">
        <h3>Price change announced</h3>
        <p className="small muted">
          Current subscribers move to these prices at their first renewal on or after{" "}
          {formatDay(open.effective_at)}. {count(open.told, "organization", "organizations")} told
          so far, {open.moved} moved.{" "}
          {begun
            ? "It has taken effect and cannot be called off."
            : "A reminder goes out a week before."}
        </p>
        {!begun && (
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={callOff.isPending}
              onClick={() => callOff.mutate()}
            >
              {callOff.isPending
                ? "Calling it off"
                : "Call it off, and email everyone who was told"}
            </button>
          </div>
        )}
        <ErrorNote error={callOff.error} />
      </div>
    );
  }

  return (
    <div className="stack-tight">
      <h3>Current subscribers</h3>
      <p className="small muted">
        To move them to these prices, announce a day. Each is moved at their first renewal on or
        after it, with nothing charged before. A price that goes up needs at least 30 days. Their
        owners are emailed now, and reminded a week before.
      </p>
      <Field
        label="From"
        type="date"
        min={dayFrom(0)}
        value={day}
        onChange={(event) => {
          setDay(event.target.value);
          setAsked(false);
          announce.reset();
        }}
      />
      {asked && (
        <p className="error" role="alert">
          This emails the owners of every subscriber on an older price of {plan.name} now, saying it
          changes on {day ? formatDay(`${day}T12:00:00.000Z`) : "that day"}. Announce again to send
          it.
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={announce.isPending || day === ""}
          onClick={() => (asked ? announce.mutate() : setAsked(true))}
        >
          {announce.isPending
            ? "Announcing"
            : asked
              ? "Announce, and send the emails"
              : "Announce to current subscribers"}
        </button>
      </div>
      <ErrorNote error={announce.error} />
    </div>
  );
}
