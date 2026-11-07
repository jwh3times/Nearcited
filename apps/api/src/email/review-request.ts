import { Resend } from "resend";
import type { ReviewRequestMessage } from "../actions/review-requests";
import type { Env } from "../env";

/**
 * A review request as it is handed to the mail service: from the product's sending address under
 * the business's name, with replies going to the location's reply address. The name is quoted, so
 * nothing in it can add an address or a header.
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
