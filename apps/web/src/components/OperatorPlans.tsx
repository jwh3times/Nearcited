import {
  type OperatorPlan,
  type PlanImpact,
  type PlanSettings,
  PlanSettingsSchema,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { formatPrice } from "../lib/billing";
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
          <PlanEditor key={plan.key} plan={plan} onDone={() => setEditing(null)} />
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
  const save = useMutation({
    mutationFn: async (confirmed: boolean) => {
      if (!confirmed && lowers(plan, settings) && plan.organizations > 0) {
        setImpact(await api.planImpact(plan.key, settings));
        return null;
      }
      return api.setPlan(plan.key, settings);
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

      {impact && (
        <p className="error" role="alert">
          This lowers what the plan allows for{" "}
          {count(impact.organizations, "organization", "organizations")}, starting now.{" "}
          {impact.prompts_set_aside > 0
            ? `${count(impact.prompts_set_aside, "of them has", "of them have")} more prompts than the new limit, and the newest of those are set aside. `
            : "None of them has more prompts than the new limit. "}
          Nothing is deleted. Save again to go ahead.
        </p>
      )}
      <div className="button-row">
        <button type="submit" disabled={save.isPending || unchanged}>
          {save.isPending ? "Saving" : impact ? "Save, and lower it for them" : "Save plan"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}
