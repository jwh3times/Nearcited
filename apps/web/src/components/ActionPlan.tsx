import type { Action } from "@nearcited/shared";

/**
 * The action plan. Each step states the observation it rests on; the links are pages the
 * assistants cited, which the providers' terms require to be shown as links.
 */
export function ActionPlan({ actions }: { actions: Action[] }) {
  return (
    <ol className="plan">
      {actions.map((action) => (
        <li key={action.id}>
          <h3>{action.title}</h3>
          <p>{action.summary}</p>
          {action.items.length > 0 && (
            <ul>
              {action.items.map((item) => (
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
          )}
        </li>
      ))}
    </ol>
  );
}
