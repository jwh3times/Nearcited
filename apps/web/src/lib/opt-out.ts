import { ApiRequestError } from "./api";

/** What the opt-out page says, and the one button it offers, if any. */
export interface OptOutPage {
  heading: string;
  body: string;
  button: string | null;
}

/**
 * What the opt-out page says at each step: before the click, while it is sent, once it is done,
 * and when it fails. A customer arrives from a review request with no account, so it explains
 * itself. Nothing is recorded until the click: a link opened by a mail scanner changes nothing.
 */
export function optOutPage(
  status: "idle" | "pending" | "success" | "error",
  error: unknown,
): OptOutPage {
  switch (status) {
    case "idle":
      return {
        heading: "Stop these review requests?",
        body: "One click and the business that sent you this link stops emailing you to ask for a review, from every one of its locations.",
        button: "Stop these emails",
      };
    case "pending":
      return { heading: "Stopping these emails", body: "One moment.", button: null };
    case "success":
      return {
        heading: "You won't be asked again",
        body: "The business that sent you this link won't email you to ask for a review again, from any of its locations.",
        button: null,
      };
    case "error":
      return error instanceof ApiRequestError && error.status === 404
        ? {
            heading: "This link does not work",
            body: "Check that it was copied whole from the email. Replying to the email reaches the business itself.",
            button: null,
          }
        : {
            heading: "That didn't go through",
            body: "Nothing was changed. Check your connection and try again.",
            button: "Try again",
          };
  }
}
