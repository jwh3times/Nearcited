import type { OperatorSpend, OperatorSpendMonth, Organization, UsageByMonth } from "./schemas";
import { type Rates, rateFor, usageCost } from "./tuning";

export interface SpendFacts {
  now: Date;
  /** How many months to show, counting this one. */
  months: number;
  rates: Rates;
  /** The organizations the operator is a member of. Theirs is counted, and marked. */
  operatorOrganizationIds: readonly string[];
  organizations: readonly Pick<Organization, "id" | "name" | "is_test">[];
  usage: readonly UsageByMonth[];
}

/** "2026-10" for the calendar month, in UTC, `back` months before the one `now` is in. */
export function monthOf(now: Date, back = 0): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return first.toISOString().slice(0, 7);
}

/** The instant a month ("2026-10") begins, in UTC. */
export const monthStart = (month: string) => `${month}-01T00:00:00.000Z`;

/** Money is added up as it comes and shown to the hundredth of a cent, no finer. */
const tidy = (dollars: number) => Math.round(dollars * 10_000) / 10_000;

/**
 * What each month cost, from what was used and what each model costs now. Usage is priced when
 * it is read, so a rate corrected later corrects the months already past. A test organization is
 * never counted: its scans are generated and use nothing.
 */
export function buildSpend(facts: SpendFacts): OperatorSpend {
  const byId = new Map(facts.organizations.map((organization) => [organization.id, organization]));
  const months: OperatorSpendMonth[] = [];

  for (let back = 0; back < facts.months; back++) {
    const month = monthOf(facts.now, back);
    const costs = new Map<string, number>();
    const unpriced = new Map<string, number>();
    let audits = 0;
    let deleted = 0;

    for (const row of facts.usage) {
      if (row.month !== month) continue;
      const organization = row.organization_id ? byId.get(row.organization_id) : undefined;
      if (organization?.is_test) continue;
      const cost = usageCost(facts.rates, row);
      if (cost === null) {
        // Under the name the vendor gave, so the missing rate can be found and added.
        if (!rateFor(facts.rates, row.model)) {
          unpriced.set(row.model, (unpriced.get(row.model) ?? 0) + row.calls);
        }
        continue;
      }
      if (row.is_audit) audits += cost;
      else if (organization) costs.set(organization.id, (costs.get(organization.id) ?? 0) + cost);
      else deleted += cost;
    }

    const organizations = [...costs]
      .map(([organization_id, cost]) => ({
        organization_id,
        name: byId.get(organization_id)?.name ?? "",
        is_yours: facts.operatorOrganizationIds.includes(organization_id),
        cost: tidy(cost),
      }))
      .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
    months.push({
      month,
      total: tidy([...costs.values()].reduce((sum, cost) => sum + cost, audits + deleted)),
      organizations,
      audits: tidy(audits),
      deleted: tidy(deleted),
      unpriced: [...unpriced]
        .map(([model, calls]) => ({ model, calls }))
        .sort((a, b) => a.model.localeCompare(b.model)),
    });
  }
  return { months };
}
