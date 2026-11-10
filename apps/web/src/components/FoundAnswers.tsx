import { type Allowances, REVIEW_REQUESTS_ALLOWANCE } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { FOUND_WORDS, foundAnswersKey, foundShown, foundVisible } from "../lib/found-answers";
import { reviewRequestsKey } from "../lib/review-requests";
import { ErrorNote } from "./ErrorNote";
import { Counted } from "./VisitCounts";

const number = (count: number) => count.toLocaleString("en-US");

interface FoundAnswersProps {
  locationId: string;
  allowances: Allowances | undefined;
}

/**
 * What customers who followed a review request said for "How did you find us?" (issue #148): by
 * answer, assistants named apart, and by month, beside the visits from assistants and never added
 * to them. Shown where the location asks for reviews, and kept where something was counted.
 */
export function FoundAnswers({ locationId, allowances }: FoundAnswersProps) {
  const included = allowances?.[REVIEW_REQUESTS_ALLOWANCE] !== undefined;
  const asking = useQuery({
    queryKey: reviewRequestsKey(locationId),
    queryFn: () => api.reviewRequests(locationId),
    enabled: included,
  });
  const found = useQuery({
    queryKey: foundAnswersKey(locationId),
    queryFn: () => api.getFoundAnswers(locationId),
  });
  if (found.isError) return <ErrorNote error={found.error} />;
  if (!found.data) return null;

  const shown = foundShown(found.data);
  const counted = shown.answered + shown.skipped;
  if (!foundVisible(Boolean(asking.data?.settings), counted)) return null;

  return (
    <div className="visit-counts">
      <h3 className="side-title">{FOUND_WORDS.heading}</h3>
      <p className="lede">
        {shown.answered === 0 ? FOUND_WORDS.none : FOUND_WORDS.some(shown.answered)}
      </p>
      {counted > 0 && (
        <>
          <Counted caption="By answer" head={["Answer", "Customers"]}>
            {shown.answers.flatMap((row) => [
              <tr key={row.answer}>
                <td className="counts-cell">{row.label}</td>
                <td className="counts-cell counts-number">{number(row.count)}</td>
              </tr>,
              ...row.assistants.map((assistant) => (
                <tr key={`${row.answer}-${assistant.name}`}>
                  <td className="counts-cell muted">{assistant.name}</td>
                  <td className="counts-cell counts-number muted">{number(assistant.count)}</td>
                </tr>
              )),
            ])}
          </Counted>
          <Counted caption="By month" head={["Month", "Answered", "Skipped"]}>
            {shown.months.map((row) => (
              <tr key={row.month}>
                <td className="counts-cell">{row.label}</td>
                <td className="counts-cell counts-number">{number(row.answered)}</td>
                <td className="counts-cell counts-number">{number(row.skipped)}</td>
              </tr>
            ))}
          </Counted>
        </>
      )}
      {found.data.sample_data && <p className="footnote">{FOUND_WORDS.sample}</p>}
      <p className="footnote">{FOUND_WORDS.tapped}</p>
      <p className="footnote">
        {FOUND_WORDS.anyone} {FOUND_WORDS.apart}
      </p>
    </div>
  );
}
