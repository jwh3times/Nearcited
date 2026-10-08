import { type AuditCell, type PublicAudit, SURFACE_LABELS } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { StepItems } from "../components/ActionPlan";
import { Labelled } from "../components/Labelled";
import { LegalLinks } from "../components/LegalLinks";
import { Logo } from "../components/Logo";
import { Quote } from "../components/Quote";
import { RateCell } from "../components/RateCell";
import { SiteChecklist } from "../components/SiteChecklist";
import { SourceTable } from "../components/SourceTable";
import { ApiRequestError, api } from "../lib/api";
import { auditAnswers, auditCompetitors, auditPending, auditSurfaces } from "../lib/audit";
import { listOf } from "../lib/format";
import { useTheme } from "../lib/theme";

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

/**
 * A shareable audit: the one page a person sees without signing in. They arrive by a link that
 * was sent to them, so it has to explain itself.
 */
export function Audit({ token }: { token: string }) {
  const audit = useQuery({
    queryKey: ["audit", token],
    queryFn: () => api.getAudit(token),
    // The report fills in a prompt at a time. Ask again until it is whole.
    refetchInterval: (query) =>
      query.state.data && auditPending(query.state.data, new Date()) ? 5000 : false,
  });

  // The link is the only key to this page, so ask search engines to leave it alone.
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    return () => robots.remove();
  }, []);

  const name = audit.data?.business_name;
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = `${name}: AI visibility report | Nearcited`;
    return () => {
      document.title = before;
    };
  }, [name]);

  // The report follows the reader's device, or the choice they made in the app.
  useTheme();

  return (
    <>
      <header className="audit-head">
        <Logo plain />
        {audit.data && (
          <span>AI visibility report · {day.format(new Date(audit.data.created_at))}</span>
        )}
      </header>
      <main className="audit-body">
        {audit.isPending && <p className="status">Loading</p>}
        {audit.isError && <Unavailable error={audit.error} />}
        {audit.data && <Report audit={audit.data} />}
      </main>
      <footer className="legal-foot">
        <LegalLinks />
      </footer>
    </>
  );
}

function Unavailable({ error }: { error: unknown }) {
  const gone = error instanceof ApiRequestError && error.status === 404;
  return (
    <div className="audit-hero">
      <div>
        <h1>{gone ? "This report is no longer available" : "This report could not be loaded"}</h1>
        <p className="lede">
          {gone
            ? "Reports are kept for 30 days, and the link may have been withdrawn. Ask whoever sent it for a new one."
            : "Something went wrong on our side. Try again in a minute."}
        </p>
      </div>
    </div>
  );
}

function Report({ audit }: { audit: PublicAudit }) {
  const surfaces = auditSurfaces(audit);
  const answers = auditAnswers(audit);
  const competitors = auditCompetitors(audit);
  const pending = auditPending(audit, new Date());
  const unfinished = audit.prompts.some((prompt) => prompt.cells === null);
  const place = [audit.city, audit.region].filter(Boolean).join(", ");
  const assistants = listOf(surfaces.map((surface) => SURFACE_LABELS[surface]));

  const columns = `minmax(13.75rem,1fr) ${surfaces.map(() => "minmax(12.5rem,16.25rem)").join(" ")}`;
  const named = audit.prompts.reduce(
    (sum, prompt) => sum + (prompt.cells ?? []).reduce((inner, cell) => inner + cell.mentions, 0),
    0,
  );

  return (
    <>
      <div className="audit-hero">
        <div>
          <p className="eyebrow">Prepared for {audit.business_name}</p>
          <h1>
            Do AI assistants recommend {audit.business_name} in {place}?
          </h1>
          {answers === 0 ? (
            <p className="explain" role="status">
              {pending
                ? "We are asking the assistants now. This page fills in by itself, usually within a couple of minutes."
                : "The assistants could not be reached, so there is nothing to show. Ask whoever sent this link to run it again."}
            </p>
          ) : (
            <p className="explain">
              We asked {assistants} the questions a customer would ask, {audit.samples} times each,
              and counted how often {audit.business_name} was named. An assistant can give a
              different answer every time, so one answer on its own says little.
            </p>
          )}
        </div>
        {answers > 0 && (
          <div className="card audit-score">
            <p className="score-big">
              {audit.score ?? 0}
              <span>/ 100</span>
            </p>
            <div className="bar ink">
              <i style={{ width: `${audit.score ?? 0}%` }} />
            </div>
            <p>
              Named in{" "}
              <span className="soft-ok">
                {named} of {answers}
              </span>{" "}
              answers. 0 means never named; 100 means named first every time. Being named lower in a
              list counts for less.
            </p>
          </div>
        )}
      </div>

      {answers > 0 && (
        <>
          <section>
            <h2 className="h-lg">How often you were named</h2>
            {(pending || unfinished) && (
              <p className="intro" role="status">
                {pending
                  ? "Still asking. The rest fills in by itself."
                  : "Some questions could not be checked, so this report covers only the ones below that have results."}
              </p>
            )}
            <div className="gtable-scroll">
              <div
                className="gtable stacks"
                style={
                  { "--cols": columns, "--min": `${15 + surfaces.length * 13.75}rem` } as never
                }
              >
                <div className="gtable-head">
                  <span>Question</span>
                  {surfaces.map((surface) => (
                    <span key={surface}>{SURFACE_LABELS[surface]}</span>
                  ))}
                </div>
                {audit.prompts.map((prompt, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: prompts are a fixed, ordered list, and two may read the same.
                  <div key={index} className="gtable-row">
                    <span>“{prompt.text}”</span>
                    {surfaces.map((surface) => (
                      <Labelled key={surface} label={SURFACE_LABELS[surface]}>
                        <Rate
                          cell={prompt.cells?.find((cell) => cell.surface === surface)}
                          waiting={pending && prompt.cells === null}
                        />
                      </Labelled>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {audit.actions.length > 0 && (
            <section>
              <h2 className="h-lg">What to do next</h2>
              <p className="intro">
                Worked out from the answers and from a check of the website, both set out below.
                Nothing here is guaranteed to change an answer; each step says what was seen, so a
                later report can show whether it moved.
              </p>
              <ol className="audit-steps">
                {audit.actions.map((action, index) => (
                  <li key={action.id} className="audit-step">
                    <span className="numeral" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="step-body">
                      <h3 className="step-name">{action.title}</h3>
                      <p>{action.summary}</p>
                      <StepItems items={action.items} />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {(competitors.length > 0 || audit.site) && (
            <div className="audit-pair">
              {competitors.length > 0 && (
                <section>
                  <h2 className="h-sm">Who else was named</h2>
                  <ul className="bars">
                    {competitors.map((competitor) => (
                      <li key={competitor.name}>
                        <span className="ellipsis">{competitor.name}</span>
                        <span className="bar">
                          <i style={{ width: `${(competitor.count / answers) * 100}%` }} />
                        </span>
                        <span className="mono">{competitor.count}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="small muted">Out of {answers} answers.</p>
                </section>
              )}
              {audit.site && (
                <section>
                  <h2 className="h-sm">Your website</h2>
                  <SiteChecklist site={audit.site} />
                </section>
              )}
            </div>
          )}

          {audit.sources.length > 0 && (
            <section>
              <h2 className="h-sm">Where the answers came from</h2>
              <p className="intro">
                The sites the assistants read before answering. They mostly repeat what these pages
                say, so a site that is read often, in answers that never name {audit.business_name},
                is the first place to check the listing.
              </p>
              <SourceTable sources={audit.sources} answers={answers} />
            </section>
          )}

          <Answers audit={audit} />
        </>
      )}

      <footer className="audit-cta">
        <div>
          <h2>Watch this change, every day.</h2>
          <p className="audit-cta-note">
            Nearcited asks these questions every day and shows whether the answer is changing. This
            report is available until {day.format(new Date(audit.expires_at))}.
          </p>
        </div>
        <a href="/">Track {audit.business_name}</a>
      </footer>
    </>
  );
}

function Rate({ cell, waiting }: { cell: AuditCell | undefined; waiting: boolean }) {
  if (!cell) return <span className="small muted">{waiting ? "Asking" : "Not checked"}</span>;
  if (cell.mentions === 0) {
    return (
      <span className="none mono">
        <span className="ring" aria-hidden="true" />
        Not named in {cell.checks}
      </span>
    );
  }
  const best = cell.positions.length > 0 ? Math.min(...cell.positions) : null;
  return (
    <span className="acell">
      <span className="top">
        <RateCell rate={cell.mentions / cell.checks} chip>
          {`Named in ${cell.mentions} of ${cell.checks}`}
        </RateCell>
        {best !== null && `As high as #${best}`}
      </span>
    </span>
  );
}

/** One quoted answer per question and assistant, with the pages that answer cited. */
function Answers({ audit }: { audit: PublicAudit }) {
  const quotes = audit.prompts.flatMap((prompt, index) =>
    (prompt.cells ?? []).flatMap((cell) =>
      cell.excerpt ? [{ key: `${index}-${cell.surface}`, prompt: prompt.text, cell }] : [],
    ),
  );
  if (quotes.length === 0) return null;
  return (
    <section>
      <h2 className="h-sm">What they said</h2>
      <p className="intro">One answer of the {audit.samples} for each question and assistant.</p>
      <div className="quotes">
        {quotes.map(({ key, prompt, cell }) => (
          <Quote
            key={key}
            assistant={SURFACE_LABELS[cell.surface]}
            prompt={prompt}
            excerpt={cell.excerpt ?? ""}
            name={audit.business_name}
            citedUrls={cell.cited_urls}
            large
          />
        ))}
      </div>
    </section>
  );
}
