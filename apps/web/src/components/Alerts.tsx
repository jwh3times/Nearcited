import { type Alert, alertDetail, groupAlerts } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import type { Tab } from "../lib/tabs";
import { ErrorNote } from "./ErrorNote";

interface AlertsProps {
  alerts: Alert[];
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: alerts are shown, not dismissed. */
  readOnly: boolean;
  onOpenTab: (tab: Tab) => void;
}

/** Where what an alert rests on is set out, and what the link there says. */
const EVIDENCE: Record<Alert["kind"], { tab: Tab; label: string }> = {
  drop: { tab: "prompts", label: "See every check" },
  competitor: { tab: "answers", label: "Read the answers" },
  site: { tab: "sources", label: "See sources" },
};

/**
 * What changed for the worse at a location, newest first. Each alert says what was seen and
 * since when, and nothing here is advice. The drops one scan raised on one surface are one card.
 * A dismissed alert leaves the page, and the same thing is raised again only once it has ended
 * and begun afresh.
 */
export function Alerts({ alerts, onChanged, readOnly, onOpenTab }: AlertsProps) {
  const dismiss = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api.dismissAlert(id))),
    onSuccess: onChanged,
  });
  if (alerts.length === 0) return null;

  return (
    <>
      <h2>Alerts</h2>
      <ul className="steps">
        {groupAlerts(alerts).map((group) => {
          const [first] = group.alerts;
          if (!first) return null;
          const evidence = EVIDENCE[first.kind];
          return (
            // A site newly read is not bad news, and the business's own is good news.
            <li key={group.key} className={`card also${first.kind === "site" ? "" : " alert"}`}>
              <div className="task-body">
                <h3>{group.title}</h3>
                {group.alerts.length === 1 ? (
                  <p>{alertDetail(first, formatDay)}</p>
                ) : (
                  <ul className="step-items">
                    {group.alerts.map((alert) => (
                      <li key={alert.id}>
                        {alert.kind === "drop" && <strong>{alert.facts.prompt}</strong>}
                        <span className="muted">{alertDetail(alert, formatDay)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {first.kind === "site" && first.facts.url && (
                  <p>
                    <a href={first.facts.url} target="_blank" rel="noopener noreferrer nofollow">
                      Open the page that was read
                    </a>
                  </p>
                )}
                <button type="button" className="go" onClick={() => onOpenTab(evidence.tab)}>
                  {evidence.label} →
                </button>
              </div>
              {!readOnly && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="link"
                    disabled={dismiss.isPending}
                    aria-label={`Dismiss: ${group.title}`}
                    onClick={() => dismiss.mutate(group.alerts.map((alert) => alert.id))}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNote error={dismiss.error} />
    </>
  );
}
