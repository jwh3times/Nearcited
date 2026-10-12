import type { ActionPlanStep } from "@nearcited/shared";
import type { ReactNode } from "react";
import { stepKey, useDone } from "../lib/done";
import { STEP_PLACE, type Tab } from "../lib/tabs";

interface ActionPlanProps {
  locationId: string;
  steps: ActionPlanStep[];
  onOpenTab: (tab: Tab) => void;
  /** True while the operator is reading a customer's account: the ticks are the customer's. */
  readOnly?: boolean;
  /** Something to do the website step's work with, shown on that step: the block to paste. */
  websiteFix?: ReactNode;
}

/** A step's evidence. The links are pages the assistants cited, which their terms require shown. */
export function StepItems({ items }: { items: ActionPlanStep["items"] }) {
  if (items.length === 0) return null;
  return (
    <ul className="step-items">
      {items.map((item) => (
        <li key={item.label}>
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer nofollow">
              {item.label}
            </a>
          ) : (
            <strong>{item.label}</strong>
          )}
          <span className="muted">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The action plan as a checklist. Each step states the observation it rests on and points to the
 * tab where that evidence is set out. Ticking a step is a note in this browser, nothing more.
 */
export function ActionPlan({
  locationId,
  steps,
  onOpenTab,
  readOnly,
  websiteFix,
}: ActionPlanProps) {
  const [done, toggle] = useDone(locationId);
  const finished = steps.filter((step) => done.has(stepKey(step))).length;

  return (
    <>
      <div className="section-head">
        <h2>What to do next</h2>
        {!readOnly && (
          <span className="mono">
            {finished} of {steps.length} done
          </span>
        )}
      </div>
      <ol className="steps">
        {steps.map((step) => {
          const place = STEP_PLACE[step.id];
          // The ticks live in the reader's browser, so the operator has none of the customer's.
          const ticked = !readOnly && done.has(stepKey(step));
          return (
            <li key={step.id} className={`card step${ticked ? " done" : ""}`}>
              {!readOnly && (
                <button
                  type="button"
                  className="check"
                  aria-pressed={ticked}
                  aria-label={`Mark "${step.title}" as done`}
                  onClick={() => toggle(stepKey(step))}
                >
                  {ticked ? "✓" : ""}
                </button>
              )}
              <div className="step-body">
                <div className="step-title">
                  <h3>{step.title}</h3>
                  <span className="kind">{place.kind}</span>
                </div>
                <p>{step.summary}</p>
                <StepItems items={step.items} />
                {step.id === "fix_website" && websiteFix}
                <button type="button" className="go" onClick={() => onOpenTab(place.tab)}>
                  {place.link} →
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
