import { Resend } from "resend";
import type { ReviewRequestMessage } from "../actions/review-requests";
import type { Env } from "../env";

/** The tag every review request carries, so the provider's reports on it can be told apart. */
export const REVIEW_REQUEST_TAG = { name: "kind", value: "review_request" } as const;

/**
 * A review request as it is handed to the mail service: from the product's sending address under
 * the business's name, with replies going to the location's reply address. The name is quoted, so
 * nothing in it can add an address or a header. Its headers name the one-click unsubscribe
 * (RFC 8058), and its tag marks it as a review request for the provider's reports.
 */
export function reviewRequestPayload(from: string, message: ReviewRequestMessage) {
  const name = message.from_name
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\"]/g, "\\$&")
    .trim();
  return {
    from: `"${name}" <${from}>`,
    to: [message.to],
    replyTo: message.reply_to,
    subject: message.subject,
    text: message.text,
    headers: {
      "List-Unsubscribe": `<${message.unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [REVIEW_REQUEST_TAG],
  };
}

/**
 * Sends one review request through Resend, keyed so that a second try at the same request sends
 * nothing more. Absent where review requests cannot be sent: no Resend key, or no
 * `REVIEW_REQUESTS_FROM`.
 */
export function reviewRequestSender(
  env: Pick<Env, "RESEND_API_KEY" | "REVIEW_REQUESTS_FROM">,
): ((message: ReviewRequestMessage) => Promise<void>) | undefined {
  const from = env.REVIEW_REQUESTS_FROM?.trim();
  if (!env.RESEND_API_KEY || !from) return undefined;
  const resend = new Resend(env.RESEND_API_KEY);
  return async (message) => {
    const { error } = await resend.emails.send(reviewRequestPayload(from, message), {
      idempotencyKey: message.key,
    });
    if (error) throw new Error(`Resend rejected the review request: ${error.message}`);
  };
}
