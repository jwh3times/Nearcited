import { type AuditCell, type PublicAudit, SURFACE_LABELS } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Sources } from "../components/Sources";
import { SourceTable } from "../components/SourceTable";
import { ApiRequestError, api } from "../lib/api";
import { auditAnswers, auditCompetitors, auditPending, auditSurfaces } from "../lib/audit";
import { listOf, plainText } from "../lib/format";
import { markName } from "../lib/matrix";

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

  return (
    <>
      <header className="topbar">
        <a href="/" className="wordmark">
          Nearcited
        </a>
      </header>
      <main className="page audit">
        {audit.isPending && <p className="status">Loading</p>}
        {audit.isError && <Unavailable error={audit.error} />}
        {audit.data && <Report audit={audit.data} />}
      </main>
    </>
  );
}

function Unavailable({ error }: { error: unknown }) {
  const gone = error instanceof ApiRequestError && error.status === 404;
  return (
    <div className="page-narrow">
      <h1>{gone ? "This report is no longer available" : "This report could not be loaded"}</h1>
      <p className="lede">
        {gone
          ? "Reports are kept for 30 days, and the link may have been withdrawn. Ask whoever sent it for a new one."
          : "Something went wrong on our side. Try again in a minute."}
      </p>
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

  return (
    <>
      <p className="breadcrumb">AI visibility report · {day.format(new Date(audit.created_at))}</p>
      <h1>
        Do AI assistants recommend {audit.business_name} in {place}?
      </h1>

      {answers === 0 ? (
        <p className="lede" role="status">
          {pending
            ? "We are asking the assistants now. This page fills in by itself, usually within a couple of minutes."
            : "The assistants could not be reached, so there is nothing to show. Ask whoever sent this link to run it again."}
        </p>
      ) : (
        <>
          <p className="lede">
            We asked {assistants} the questions a customer would ask, {audit.samples} times each,
            and counted how often {audit.business_name} was named. An assistant can give a different
            answer every time, so one answer on its own says little.
          </p>

          <div className="audit-score">
            <p className="audit-score-number">
              {audit.score ?? 0}
              <span> / 100</span>
            </p>
            <p>
              <strong>Visibility score.</strong> 0 means never named. 100 means named first in every
              answer. Being named lower in a list counts for less.
            </p>
          </div>

          {(pending || unfinished) && (
            <p className="window-note" role="status">
              {pending
                ? "Still asking. The rest fills in by itself."
                : "Some questions could not be checked, so this report covers only the ones below that have results."}
            </p>
          )}

          <section className="section">
            <h2>How often it was named</h2>
            <div className="matrix-scroll">
              <table className="matrix">
                <thead>
                  <tr>
                    <td />
                    {surfaces.map((surface) => (
                      <th key={surface} scope="col">
                        {SURFACE_LABELS[surface]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {audit.prompts.map((prompt, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: prompts are a fixed, ordered list, and two may read the same.
                    <tr key={index}>
                      <th scope="row">{prompt.text}</th>
                      {surfaces.map((surface) => (
                        <td key={surface}>
                          <Rate
                            cell={prompt.cells?.find((cell) => cell.surface === surface)}
                            waiting={pending && prompt.cells === null}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {competitors.length > 0 && (
            <section className="section">
              <h2>Who else was named</h2>
              <p className="muted">Out of {answers} answers.</p>
              <ul className="tally">
                {competitors.map((competitor) => (
                  <li key={competitor.name}>
                    <span>{competitor.name}</span>
                    <span className="muted">{competitor.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {audit.sources.length > 0 && (
            <section className="section">
              <h2>Where the answers came from</h2>
              <p className="muted audit-note">
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

      <footer className="audit-footer">
        <p>
          Nearcited asks these questions every day and shows whether the answer is changing.{" "}
          <a href="/">See how it works</a>.
        </p>
        <p className="muted">
          This report is available until {day.format(new Date(audit.expires_at))}.
        </p>
      </footer>
    </>
  );
}

function Rate({ cell, waiting }: { cell: AuditCell | undefined; waiting: boolean }) {
  if (!cell) return <span className="unchecked">{waiting ? "Asking" : "Not checked"}</span>;
  if (cell.mentions === 0) {
    return (
      <span className="absent">
        <span className="absent-ring" aria-hidden="true" />
        Not named in {cell.checks}
      </span>
    );
  }
  const best = cell.positions.length > 0 ? Math.min(...cell.positions) : null;
  return (
    <span className="rate">
      <span className="named">
        Named in {cell.mentions} of {cell.checks}
      </span>
      {best !== null && <span className="rate-latest">As high as #{best}</span>}
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
    <section className="section">
      <h2>What they said</h2>
      <p className="muted">One answer of the {audit.samples} for each question and assistant.</p>
      <ul className="excerpts">
        {quotes.map(({ key, prompt, cell }) => (
          <li key={key}>
            <h3>
              {SURFACE_LABELS[cell.surface]}
              <span className="muted">{prompt}</span>
            </h3>
            <p>
              {markName(plainText(cell.excerpt ?? ""), audit.business_name).map((part, index) =>
                part.marked ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
                  <mark key={index}>{part.text}</mark>
                ) : (
                  part.text
                ),
              )}
            </p>
            <Sources urls={cell.cited_urls} />
          </li>
        ))}
      </ul>
    </section>
  );
}
