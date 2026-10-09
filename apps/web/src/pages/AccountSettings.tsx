import {
  type Organization,
  OrganizationInputSchema,
  PLAN_ASSISTANTS,
  SURFACE_LABELS,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { listOf } from "../lib/format";
import { supabase } from "../lib/supabase";

interface AccountSettingsProps {
  organization: Organization;
  email: string | null;
}

/**
 * The organization and the account behind it: its name, what its plan allows, and who is signed
 * in. Changing the plan and paying for it belong here too, once they exist.
 */
export function AccountSettings({ organization, email }: AccountSettingsProps) {
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const every = organization.scan_every_days;
  const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 300_000 });
  const plan = plans.data?.find((candidate) => candidate.key === organization.plan_key);

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
                <span>{organization.max_manual_scans_per_month} a month</span>
              </li>
              <li>
                <span>Report by email</span>
                <span>
                  {organization.emails_report ? "After each scheduled scan" : "Not included"}
                </span>
              </li>
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
            <p>
              Changing the plan and paying for it are not built yet. When they are, they will be
              here.
            </p>
          </div>

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
