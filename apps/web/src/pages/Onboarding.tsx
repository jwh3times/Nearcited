import {
  LocationInputSchema,
  OrganizationInputSchema,
  TrackedQueryInputSchema,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { LegalLinks } from "../components/LegalLinks";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { PRESELECTED, suggestPrompts } from "../lib/onboarding";

const STEPS = ["Organization", "Location", "Prompts", "First scan"];

const EMPTY = { name: "", category: "", city: "", region: "", website: "" };

/**
 * The first location, as this page asks for it: a location, plus what it is, which is asked for
 * here because the suggested prompts are written from it.
 */
const FirstLocationSchema = z
  .object({ category: z.string().trim().min(1, "Say what the business is, like pizza restaurant") })
  .and(LocationInputSchema);

/**
 * The first run: an organization, its first location, a few prompts, then the first scan.
 * Nothing is created until the last step, so going back never leaves half a setup behind.
 */
export function Onboarding({ sampleData }: { sampleData: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [organization, setOrganization] = useState("");
  const [location, setLocation] = useState(EMPTY);
  const [picked, setPicked] = useState<string[] | null>(null);
  // What the last step has already created, so trying again after a failure does not repeat it.
  const made = useRef<{ organizationId?: string; locationId?: string; prompts: string[] }>({
    prompts: [],
  });

  // A new organization starts on the free plan, which says how many prompts it may track.
  const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 300_000 });
  const allowed =
    plans.data?.find((plan) => plan.key === "free")?.max_queries_per_location ?? PRESELECTED;

  const suggestions = suggestPrompts(location.category, location.city);
  // The reader's own prompts sit in the same list as the suggestions, and are chosen the same way.
  const [own, setOwn] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string>();
  const options = [...suggestions, ...own];
  // Until the reader changes the ticks, the first few suggestions are chosen for them.
  const chosen = (picked ?? suggestions.slice(0, Math.min(PRESELECTED, allowed)))
    .filter((prompt) => options.includes(prompt))
    .slice(0, allowed);
  const full = chosen.length >= allowed;

  function addOwn() {
    const parsed = TrackedQueryInputSchema.shape.text.safeParse(draft);
    if (!parsed.success) return setDraftError(parsed.error.issues[0]?.message);
    const text = parsed.data;
    if (options.some((prompt) => prompt.toLowerCase() === text.toLowerCase())) {
      return setDraftError("That prompt is already in the list");
    }
    setOwn([...own, text]);
    // Chosen at once while there is room. When there is none, it waits to be swapped in.
    if (!full) setPicked([...chosen, text]);
    setDraft("");
    setDraftError(undefined);
  }
  const place = [location.city, location.region].filter(Boolean).join(", ");

  const start = useMutation({
    mutationFn: async () => {
      const done = made.current;
      done.organizationId ??= (await api.createOrganization(organization)).id;
      done.locationId ??= (
        await api.createLocation(done.organizationId, {
          name: location.name,
          city: location.city,
          region: location.region,
          website: location.website,
          primary_category: location.category,
        })
      ).id;
      for (const text of chosen) {
        if (done.prompts.includes(text)) continue;
        await api.createQuery(done.locationId, { kind: "ai_prompt", text });
        done.prompts.push(text);
      }
      // The setup stands even if the scan cannot start; the location page says why and offers it.
      await api.startScan(done.locationId).catch(() => null);
      return done.locationId;
    },
    onSuccess: async (locationId) => {
      navigate(`/locations/${locationId}`);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  // Each step is checked with the schema the API will use when the last step sends it all.
  const organization$ = useFormErrors(OrganizationInputSchema, { name: organization });
  const location$ = useFormErrors(FirstLocationSchema, location);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 0 && !organization$.check()) return;
    if (step === 1 && !location$.check()) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else start.mutate();
  }
  const field = (name: keyof typeof EMPTY) => ({
    value: location[name],
    error: location$.error(name),
    onBlur: () => location$.touch(name),
    onChange: (event: { target: { value: string } }) =>
      setLocation((current) => ({ ...current, [name]: event.target.value })),
  });

  return (
    <>
      <header className="onb-top">
        <Logo plain />
        <ol className="stepper">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={index < step ? "done" : undefined}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="num">{index < step ? "✓" : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>
      {sampleData && (
        <p className="sample-banner">
          Scans are returning generated sample data, not real measurements.
        </p>
      )}

      <form className="onb-body" onSubmit={submit} noValidate>
        <header>
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </p>
          {step === 0 && (
            <>
              <h1>What should we call your organization?</h1>
              <p className="lede">
                The business or agency these locations belong to. Teammates you add later will see
                everything under it.
              </p>
            </>
          )}
          {step === 1 && (
            <>
              <h1>Add your first location</h1>
              <p className="lede">
                A storefront or service area. Scans ask about the business by this name, in this
                city.
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <h1>What would a customer ask?</h1>
              <p className="lede">
                You start on the free plan, which tracks {allowed}{" "}
                {allowed === 1 ? "prompt" : "prompts"}. Choose the {allowed} you want asked about{" "}
                {location.name || "the business"}, from these or in your own words. A paid plan
                tracks more, and you can change them at any time.
              </p>
            </>
          )}
          {step === 3 && (
            <>
              <h1>Ready for the first scan</h1>
              <p className="lede">
                An assistant can answer the same question differently each time, so the picture
                fills in over the first few scans.
              </p>
            </>
          )}
        </header>

        {step === 0 && (
          <Field
            label="Organization name"
            className="tall"
            required
            maxLength={120}
            value={organization}
            error={organization$.error("name")}
            onBlur={() => organization$.touch("name")}
            onChange={(event) => setOrganization(event.target.value)}
          />
        )}

        {step === 1 && (
          <div className="two-col">
            <Field label="Business name" required maxLength={120} {...field("name")} />
            <Field
              label="What it is"
              required
              maxLength={120}
              placeholder="Pizza restaurant"
              {...field("category")}
            />
            <Field label="City" required maxLength={80} {...field("city")} />
            <Field label="State or region" maxLength={80} {...field("region")} />
            <Field
              label="Website"
              inputMode="url"
              autoCapitalize="none"
              placeholder="joespizza.com"
              maxLength={200}
              {...field("website")}
            />
          </div>
        )}

        {step === 2 && (
          <>
            <ul className="choices">
              {options.map((prompt) => (
                <li key={prompt}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.includes(prompt)}
                      // At the limit, another can be ticked only after one is unticked.
                      disabled={!chosen.includes(prompt) && full}
                      onChange={(event) =>
                        setPicked(
                          event.target.checked
                            ? [...chosen, prompt]
                            : chosen.filter((item) => item !== prompt),
                        )
                      }
                    />
                    {prompt}
                  </label>
                </li>
              ))}
            </ul>
            <div className="add-row">
              <div className="grow">
                <Field
                  label="Or write your own"
                  placeholder={`Who is the best ${location.category.toLowerCase() || "business"} near me?`}
                  maxLength={300}
                  value={draft}
                  error={draftError}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setDraftError(undefined);
                  }}
                  // Enter adds the prompt. It must not send the form on to the next step.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addOwn();
                  }}
                />
              </div>
              <button type="button" className="secondary" onClick={addOwn}>
                Add to the list
              </button>
            </div>
            <p className="small muted" role="status">
              {chosen.length} of {allowed} chosen.
              {full && options.length > chosen.length
                ? " To choose a different one, untick one first."
                : ""}
            </p>
          </>
        )}

        {step === 3 && (
          <ul className="card summary-card">
            <li>
              <span>Organization</span>
              <span>{organization}</span>
            </li>
            <li>
              <span>Location</span>
              <span>
                {location.name}, {place}
              </span>
            </li>
            <li>
              <span>Prompts</span>
              <span>
                {chosen.length === 0
                  ? "None yet. The first scan waits until you add one."
                  : chosen.join(" · ")}
              </span>
            </li>
            <li>
              <span>After this</span>
              <span>Scanned on a schedule, as often as your plan allows.</span>
            </li>
          </ul>
        )}

        <ErrorNote error={start.error} />

        <div className="onb-foot">
          {step > 0 && (
            <button
              type="button"
              className="link"
              disabled={start.isPending}
              onClick={() => setStep(step - 1)}
            >
              ← Back
            </button>
          )}
          <button type="submit" disabled={start.isPending}>
            {step < STEPS.length - 1
              ? "Continue"
              : start.isPending
                ? "Setting up"
                : chosen.length > 0
                  ? "Run first scan"
                  : "Finish"}
          </button>
        </div>
      </form>
      <footer className="legal-foot">
        <LegalLinks />
      </footer>
    </>
  );
}
