import type { Action } from "@nearcited/shared";
import { stepKey, useDone } from "../lib/done";
import { ACTION_PLACE, type Tab } from "../lib/tabs";

interface ActionPlanProps {
  locationId: string;
  actions: Action[];
  onOpenTab: (tab: Tab) => void;
  /** True while the operator is reading a customer's account: the ticks are the customer's. */
  readOnly?: boolean;
}

/** A step's evidence. The links are pages the assistants cited, which their terms require shown. */
export function StepItems({ items }: { items: Action["items"] }) {
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
export function ActionPlan({ locationId, actions, onOpenTab, readOnly }: ActionPlanProps) {
  const [done, toggle] = useDone(locationId);
  const finished = actions.filter((action) => done.has(stepKey(action))).length;

  return (
    <>
      <div className="section-head">
        <h2>What to do next</h2>
        {!readOnly && (
          <span className="mono">
            {finished} of {actions.length} done
          </span>
        )}
      </div>
      <ol className="steps">
        {actions.map((action) => {
          const place = ACTION_PLACE[action.id];
          // The ticks live in the reader's browser, so the operator has none of the customer's.
          const ticked = !readOnly && done.has(stepKey(action));
          return (
            <li key={action.id} className={`card step${ticked ? " done" : ""}`}>
              {!readOnly && (
                <button
                  type="button"
                  className="check"
                  aria-pressed={ticked}
                  aria-label={`Mark "${action.title}" as done`}
                  onClick={() => toggle(stepKey(action))}
                >
                  {ticked ? "✓" : ""}
                </button>
              )}
              <div className="step-body">
                <div className="step-title">
                  <h3>{action.title}</h3>
                  <span className="kind">{place.kind}</span>
                </div>
                <p>{action.summary}</p>
                <StepItems items={action.items} />
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
