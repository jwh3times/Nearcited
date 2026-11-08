import type { StopReason } from "@nearcited/shared";
import { z } from "zod";
import { REVIEW_REQUEST_TAG } from "./review-request";

/**
 * What the email provider reports of the review requests it sent (issue #293): a hard bounce or a
 * complaint, which stop every organization asking that address again. The report arrives with no
 * signed-in user, and only its signature says it came from Resend, so nothing in it counts until
 * that is checked.
 */

/** The report is not signed with this deployment's secret, or not recently. */
export class ReportSignatureError extends Error {}

/** How far a report's timestamp may be from now: a replay older than this is refused. */
const TOLERANCE_SECONDS = 5 * 60;

const encoder = new TextEncoder();

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Checks a Standard Webhooks signature, as Resend signs its webhooks: HMAC-SHA256, keyed by the
 * secret after `whsec_`, over `id.timestamp.body`, base64, one of the space-separated `v1,`
 * signatures. Throws where it does not verify.
 */
async function verify(
  body: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now: Date,
): Promise<void> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) {
    throw new ReportSignatureError("The report is not signed.");
  }
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new ReportSignatureError("The report's timestamp is too far from now.");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      fromBase64(secret.replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new ReportSignatureError("The webhook secret is not one.");
  }
  const signed = encoder.encode(`${id}.${timestamp}.${body}`);
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value || !/^[A-Za-z0-9+/]+=*$/.test(value)) continue;
    // A constant-time comparison.
    if (await crypto.subtle.verify("HMAC", key, fromBase64(value), signed)) return;
  }
  throw new ReportSignatureError("The signature did not verify.");
}

const ReportSchema = z.object({
  type: z.string(),
  data: z.object({
    to: z.array(z.string()).default([]),
    tags: z.record(z.string(), z.string()).nullish(),
    bounce: z.object({ type: z.string() }).nullish(),
  }),
});

/** The address in `Name <address>`, or the whole of it, as the provider writes a recipient. */
const addressOf = (recipient: string) =>
  (recipient.match(/<([^<>]+)>\s*$/)?.[1] ?? recipient).trim();

/**
 * What a signed report from the provider says to stop: the addresses a review request bounced
 * hard from, or whose owner complained of one, and why. Null for anything else: a soft bounce,
 * any other event, or a report of an email that is not a review request. Throws
 * `ReportSignatureError` where the report is not signed with `secret`.
 */
export async function readEmailReport(
  body: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now = new Date(),
): Promise<{ reason: StopReason; addresses: string[] } | null> {
  await verify(body, headers, secret, now);
  let report: z.infer<typeof ReportSchema>;
  try {
    report = ReportSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }
  const { data } = report;
  if (data.tags?.[REVIEW_REQUEST_TAG.name] !== REVIEW_REQUEST_TAG.value) return null;
  const addresses = data.to.map(addressOf).filter((address) => address.includes("@"));
  if (addresses.length === 0) return null;
  if (report.type === "email.complained") return { reason: "complaint", addresses };
  // A soft bounce is neither kept nor tried again.
  if (report.type === "email.bounced" && data.bounce?.type === "Permanent") {
    return { reason: "bounce", addresses };
  }
  return null;
}
