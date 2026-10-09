import type { LoweredLimits, Plan, PlanSettings } from "./schemas";

type Limits = Pick<
  Plan,
  | "max_queries_per_location"
  | "assistants"
  | "scan_every_days"
  | "max_manual_scans_per_month"
  | "emails_report"
>;

/**
 * The limits that `to` would lower, each with what it is and what it would become. More days
 * between scans is a reduction, and so is a report that stops. Raising a limit is not here: it
 * takes nothing from anyone. The database works out the same thing in `plan_reductions()`.
 */
export function reductions(plan: Limits, to: Limits): LoweredLimits {
  const lowered: LoweredLimits = {};
  if (to.max_queries_per_location < plan.max_queries_per_location) {
    lowered.max_queries_per_location = {
      from: plan.max_queries_per_location,
      to: to.max_queries_per_location,
    };
  }
  if (to.assistants < plan.assistants) {
    lowered.assistants = { from: plan.assistants, to: to.assistants };
  }
  if (to.scan_every_days > plan.scan_every_days) {
    lowered.scan_every_days = { from: plan.scan_every_days, to: to.scan_every_days };
  }
  if (to.max_manual_scans_per_month < plan.max_manual_scans_per_month) {
    lowered.max_manual_scans_per_month = {
      from: plan.max_manual_scans_per_month,
      to: to.max_manual_scans_per_month,
    };
  }
  if (plan.emails_report && !to.emails_report) {
    lowered.emails_report = { from: true, to: false };
  }
  return lowered;
}

/** `settings` with every limit it would lower put back to what the plan has now. */
export function withoutReductions(plan: Limits, settings: PlanSettings): PlanSettings {
  const lowered = reductions(plan, settings);
  return {
    ...settings,
    ...Object.fromEntries(
      (Object.keys(lowered) as (keyof LoweredLimits)[]).map((field) => [field, plan[field]]),
    ),
  };
}

const every = (days: number) => (days === 1 ? "every day" : `every ${days} days`);

/**
 * A reduction in words, one line for each limit that goes down, for an email or a page. `made`
 * is for one already made: "before" and "now", where one still to come has "now" and "after".
 */
export function describeLowered(lowered: LoweredLimits, made = false): string[] {
  const [was, becomes] = made ? ["before", "now"] : ["now", "after"];
  const lines: string[] = [];
  const prompts = lowered.max_queries_per_location;
  if (prompts) {
    lines.push(
      `Prompts and keywords for each location: ${prompts.from} ${was}, ${prompts.to} ${becomes}`,
    );
  }
  if (lowered.assistants) {
    lines.push(
      `Assistants checked: ${lowered.assistants.from} ${was}, ${lowered.assistants.to} ${becomes}${
        lowered.assistants.to === 1 ? ", and you choose which" : ""
      }`,
    );
  }
  if (lowered.scan_every_days) {
    lines.push(
      `Scheduled scans: ${every(lowered.scan_every_days.from)} ${was}, ${every(lowered.scan_every_days.to)} ${becomes}`,
    );
  }
  const manual = lowered.max_manual_scans_per_month;
  if (manual) {
    lines.push(
      `Scans you can run by hand each month: ${manual.from} ${was}, ${manual.to} ${becomes}`,
    );
  }
  if (lowered.emails_report) {
    lines.push(`The report by email after each scan: included ${was}, not ${becomes}`);
  }
  return lines;
}
