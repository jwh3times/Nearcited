import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { PRESELECTED, suggestPrompts } from "../lib/onboarding";

const STEPS = ["Organization", "Location", "Prompts", "First scan"];

const EMPTY = { name: "", category: "", city: "", region: "", website: "" };

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

  const suggestions = suggestPrompts(location.category, location.city);
  // Until the reader changes the ticks, the first few suggestions are chosen for them.
  const chosen = (picked ?? suggestions.slice(0, PRESELECTED)).filter((prompt) =>
    suggestions.includes(prompt),
  );
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

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step < STEPS.length - 1) setStep(step + 1);
    else start.mutate();
  }
  const field = (name: keyof typeof EMPTY) => ({
    value: location[name],
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

      <form className="onb-body" onSubmit={submit}>
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
                Pick the questions to ask the assistants about {location.name || "the business"}.
                You can add your own, or retire any of these, later.
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
          <label>
            Organization name
            <input
              className="tall"
              required
              maxLength={120}
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
            />
          </label>
        )}

        {step === 1 && (
          <div className="two-col">
            <label>
              Business name
              <input required maxLength={120} {...field("name")} />
            </label>
            <label>
              What it is
              <input
                required
                maxLength={120}
                placeholder="Pizza restaurant"
                {...field("category")}
              />
            </label>
            <label>
              City
              <input required maxLength={80} {...field("city")} />
            </label>
            <label>
              State or region
              <input maxLength={80} {...field("region")} />
            </label>
            <label>
              Website
              <input type="url" placeholder="https://" maxLength={200} {...field("website")} />
            </label>
          </div>
        )}

        {step === 2 && (
          <>
            <ul className="choices">
              {suggestions.map((prompt) => (
                <li key={prompt}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.includes(prompt)}
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
            <p className="small muted">
              {chosen.length} of {suggestions.length} chosen. Each is asked of every assistant your
              plan checks, once per scan.
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
    </>
  );
}
