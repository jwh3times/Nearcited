import { type Alert, alertDetail, groupAlerts } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { ErrorNote } from "./ErrorNote";

interface AlertsProps {
  alerts: Alert[];
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: alerts are shown, not dismissed. */
  readOnly: boolean;
  /** Opens the tab where each prompt's checks are set out. */
  onOpenPrompts: () => void;
}

/**
 * What got worse at a location, newest first. Each alert says what was seen and since when, and
 * nothing here is advice. The drops one scan raised on one surface are one card. A dismissed
 * alert leaves the page, and the same thing is raised again only once it has ended and begun
 * afresh.
 */
export function Alerts({ alerts, onChanged, readOnly, onOpenPrompts }: AlertsProps) {
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
          const [only] = group.alerts;
          return (
            <li key={group.key} className="card also alert">
              <div className="task-body">
                <h3>{group.title}</h3>
                {group.alerts.length === 1 && only ? (
                  <p>{alertDetail(only, formatDay)}</p>
                ) : (
                  <ul className="step-items">
                    {group.alerts.map((alert) => (
                      <li key={alert.id}>
                        <strong>{alert.facts.prompt}</strong>
                        <span className="muted">{alertDetail(alert, formatDay)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="go" onClick={onOpenPrompts}>
                  See every check →
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
