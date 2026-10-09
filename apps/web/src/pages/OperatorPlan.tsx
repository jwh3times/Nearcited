import {
  type Organization,
  type OrganizationLimits,
  OrganizationLimitsSchema,
  SURFACE_LABELS,
} from "@nearcited/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { listOf } from "../lib/format";

const FIELDS: { name: keyof OrganizationLimits; label: string; hint: string }[] = [
  { name: "max_locations", label: "Locations", hint: "How many it may have." },
  {
    name: "max_queries_per_location",
    label: "Prompts and keywords per location",
    hint: "Retired ones do not count.",
  },
  {
    name: "max_manual_scans_per_day",
    label: "Scans run by hand per day",
    hint: "Across the organization, in any 24 hours.",
  },
  { name: "scan_every_days", label: "Days between scheduled scans", hint: "1 is daily." },
];

const asText = (organization: Organization) =>
  Object.fromEntries(FIELDS.map(({ name }) => [name, String(organization[name])])) as Record<
    keyof OrganizationLimits,
    string
  >;

/** An empty field is not zero: it is nothing, and the schema says so. */
const asNumbers = (text: Record<keyof OrganizationLimits, string>) =>
  Object.fromEntries(
    FIELDS.map(({ name }) => [name, text[name].trim() === "" ? Number.NaN : Number(text[name])]),
  ) as OrganizationLimits;

/**
 * What a customer's plan allows, and the one form on their account the operator may send. The
 * database records each change (docs/adr/0005-the-operator-changes-limits-through-one-function.md).
 */
export function OperatorPlan({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => asText(organization));
  const limits = asNumbers(text);
  const form$ = useFormErrors(OrganizationLimitsSchema, limits);
  const save = useMutation({
    mutationFn: () => api.setOrganizationLimits(organization.id, limits),
    onSuccess: async (saved) => {
      setText(asText(saved));
      queryClient.setQueryData(["operator-organization", organization.id], saved);
      // The operator's own list of organizations shows these limits too.
      await queryClient.invalidateQueries({ queryKey: ["operator-overview"] });
    },
  });
  const unchanged = FIELDS.every(({ name }) => limits[name] === organization[name]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) save.mutate();
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="small muted">{organization.name}</p>
          <h1>Plan and limits</h1>
        </div>
      </div>

      <div className="settings">
        <form onSubmit={submit} className="card settings-main" noValidate>
          <div>
            <h2>Limits</h2>
            <p className="small muted">
              Lowering a limit removes nothing. It only stops more being added, and a schedule
              change takes effect at the next daily run.
            </p>
          </div>
          {FIELDS.map(({ name, label, hint }) => (
            <Field
              key={name}
              label={label}
              hint={hint}
              inputMode="numeric"
              required
              value={text[name]}
              error={form$.error(name)}
              onBlur={() => form$.touch(name)}
              onChange={(event) => {
                setText({ ...text, [name]: event.target.value });
                save.reset();
              }}
            />
          ))}
          <button type="submit" disabled={save.isPending || unchanged}>
            {save.isPending ? "Saving" : "Save limits"}
          </button>
          {save.isSuccess && (
            <p className="small muted" role="status">
              Saved.
            </p>
          )}
          <ErrorNote error={save.error} />
        </form>

        <div className="settings-side">
          <div className="card side-card">
            <h3 className="side-title">Not changed here</h3>
            <ul className="facts">
              <li>
                <span>Checked on</span>
                <span>
                  {organization.surfaces
                    ? listOf(organization.surfaces.map((surface) => SURFACE_LABELS[surface]))
                    : "Everything that is set up"}
                </span>
              </li>
              <li>
                <span>Sample data</span>
                <span>{organization.is_test ? "Yes, a test organization" : "No"}</span>
              </li>
            </ul>
            <p>Each change to the limits is recorded with who made it and what it replaced.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
