import {
  type ApprovedWording,
  approvedWording,
  type OptOutMessage,
  OptOutMessageSchema,
  type StoppedAddressMessage,
  StoppedAddressMessageSchema,
  siteName,
} from "@nearcited/shared";
import { secretBytes } from "../connections/seal";
import type { KeptReviewRequests, Store } from "../store/types";

/**
 * Review requests (issue #292, part of #146): the worker proposes asking each ready customer
 * contact for a review, and sends the request once a member, or standing permission, approved it
 * and its morning came (`docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`,
 * `docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`).
 *
 * Whom an organization asked, and who opted out of it, is kept as a keyed fingerprint of the
 * address that cannot be read back. Its key, like the key of the links to opt out, is derived from
 * the deployment's `CONNECTIONS_KEY`, so it is never one more secret to keep.
 */

/** The keys review requests use, each derived from `CONNECTIONS_KEY` for that use alone. */
export interface AskingKeys {
  /** The keyed fingerprint of an address: the same for the same address however it is written. */
  fingerprint(address: string): Promise<string>;
  /**
   * What a link to opt out carries for one address and organization: the organization, the
   * address's fingerprint and a signature over both, never the address.
   */
  optOutToken(organizationId: string, fingerprint: string): Promise<string>;
  /**
   * What a link to opt out carries, once its signature is checked: null for a token this
   * deployment did not sign.
   */
  readOptOutToken(token: string): Promise<OptOutMessage["opt_out"] | null>;
  /**
   * What a customer's link to the review form carries (`/r/<token>`): the request's action, the
   * review form it was sent with and the business's name the email gave, signed, and never the
   * address. Everything the question's page shows and where it leads is in it, so its route reads
   * nothing (`docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`).
   */
  foundToken(link: FoundLink): Promise<string>;
  /** What a link to the review form carries, once its signature is checked: null for any other. */
  readFoundToken(token: string): Promise<FoundLink | null>;
}

/** What a customer's link to the review form carries. */
export interface FoundLink {
  action_id: string;
  /** The review form, as the email was sent with it. */
  form: string;
  /** The business's name, as the email was sent under it. */
  business: string;
}

/** One review request as it is sent. */
export interface ReviewRequestMessage {
  /** The business's name, which the email is sent under. */
  from_name: string;
  to: string;
  /** The location's reply address. */
  reply_to: string;
  subject: string;
  text: string;
  /** The same for every try at the same request, so the provider sends it once. */
  key: string;
  /** Where one click opts the customer out, named in the email's unsubscribe headers. */
  unsubscribe: string;
}

/** What review requests need of the deployment. */
export interface Asking {
  keys: AskingKeys;
  /** Where the web app is, for the link to opt out. */
  appUrl: string;
  /** True where this deployment's data is generated: nothing is sent. */
  sampleData: boolean;
  /** Sends one request. Absent where outgoing email for review requests is not set up. */
  send?: (message: ReviewRequestMessage) => Promise<void>;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

const base64Url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** An HMAC key derived from the secret for one use, named by `label`. */
async function derived(secret: Uint8Array<ArrayBuffer>, label: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(label) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** The bytes a base64url signature stands for, or null where it is not one. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * The keys review requests use, from a deployment's `CONNECTIONS_KEY`. Null where none is set,
 * which proposes and sends nothing.
 */
export async function askingKeys(secret: string | undefined): Promise<AskingKeys | null> {
  const bytes = secretBytes(secret);
  if (!bytes) return null;
  const fingerprintKey = await derived(bytes, "nearcited review request fingerprint");
  const linkKey = await derived(bytes, "nearcited review request opt-out link");
  const foundKey = await derived(bytes, "nearcited review request found link");
  const sign = (key: CryptoKey, text: string) =>
    crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return {
    fingerprint: async (address) => hex(await sign(fingerprintKey, address.trim().toLowerCase())),
    optOutToken: async (organizationId, fingerprint) => {
      const carried = `${organizationId}.${fingerprint}`;
      return `${carried}.${base64Url(await sign(linkKey, carried))}`;
    },
    readOptOutToken: async (token) => {
      const parts = token.split(".");
      const [organizationId = "", fingerprint = "", signature = ""] = parts;
      const bytes = fromBase64Url(signature);
      if (parts.length !== 3 || !bytes) return null;
      if (!UUID.test(organizationId) || !FINGERPRINT.test(fingerprint)) return null;
      // A constant-time check of the signature over what the link carries.
      const signed = await crypto.subtle.verify(
        "HMAC",
        linkKey,
        bytes,
        encoder.encode(`${organizationId}.${fingerprint}`),
      );
      return signed ? { organization_id: organizationId, fingerprint } : null;
    },
    foundToken: async (link) => {
      const carried = `${FOUND_VERSION}.${base64Url(
        encoder.encode(JSON.stringify([link.action_id, link.form, link.business])),
      )}`;
      return `${carried}.${base64Url(await sign(foundKey, carried))}`;
    },
    readFoundToken: async (token) => {
      const parts = token.split(".");
      const [version = "", payload = "", signature = ""] = parts;
      const bytes = fromBase64Url(signature);
      if (parts.length !== 3 || version !== FOUND_VERSION || !bytes) return null;
      if (payload.length > LONGEST_FOUND_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
      const signed = await crypto.subtle.verify(
        "HMAC",
        foundKey,
        bytes,
        encoder.encode(`${version}.${payload}`),
      );
      return signed ? readFoundPayload(payload) : null;
    },
  };
}

/**
 * The version of a link to the review form. A link sent in an email lives for years, so a new
 * format takes a new version and every earlier one is still read.
 */
const FOUND_VERSION = "f1";

/** Longer than any link this deployment signs. Anything longer is not worth a signature check. */
const LONGEST_FOUND_PAYLOAD = 2048;

/** What a signed link to the review form carries, or null where it is not that. */
function readFoundPayload(payload: string): FoundLink | null {
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const [action_id, form, business] = JSON.parse(text) as unknown[];
    if (typeof action_id !== "string" || !UUID.test(action_id)) return null;
    if (typeof form !== "string" || new URL(form).protocol !== "https:") return null;
    if (typeof business !== "string" || business === "") return null;
    return { action_id, form, business };
  } catch {
    return null;
  }
}

/**
 * The email a location's customers are sent now, as its owner approved it: from its name, the site
 * chosen and its listing there, with its review requests' settings. Null where they are off, or the
 * location has no review form left on the site chosen.
 */
export async function currentWording(
  store: Store,
  locationId: string,
): Promise<{ settings: KeptReviewRequests; email: ApprovedWording } | null> {
  const [location, settings, listings] = await Promise.all([
    store.getLocation(locationId),
    store.getLocationReviewRequests(locationId),
    store.listListings(locationId),
  ]);
  const email =
    location && settings ? approvedWording(location.name, settings.site, listings) : null;
  return settings && email ? { settings, email } : null;
}

/**
 * Proposes asking each ready customer contact no request was proposed for yet, in the wording its
 * location's owner approved. A location with no review form left on the site chosen proposes
 * nothing: its contacts wait, until their week is over. Returns how many were proposed, approved by
 * standing permission as they were made included.
 */
export async function proposeReviewRequests({
  store,
  asking,
}: {
  store: Store;
  asking: Asking;
}): Promise<number> {
  const wordings = new Map<string, Awaited<ReturnType<typeof currentWording>>>();
  const wordingOf = async (locationId: string) => {
    if (!wordings.has(locationId))
      wordings.set(locationId, await currentWording(store, locationId));
    return wordings.get(locationId) ?? null;
  };

  let proposed = 0;
  for (const contact of await store.listContactsToAsk()) {
    const now = await wordingOf(contact.location_id);
    // With no wording the contact is still checked, so one whose week is over is not kept.
    const outcome = await store.proposeReviewRequest(
      contact.id,
      await asking.keys.fingerprint(contact.address),
      now ? `Ask ${contact.masked} for a review on ${siteName(now.settings.site)}` : "",
      now?.email.body ?? null,
    );
    if (outcome === "proposed" || outcome === "approved") proposed++;
  }
  return proposed;
}

/** What a route checked and queued for the worker: an opt-out, or a bounce or a complaint. */
export type DoNotAskMessage = OptOutMessage | StoppedAddressMessage;

/** The message a route queued for `recordDoNotAsk`, or null where the body is not one. */
export function readDoNotAskMessage(body: unknown): DoNotAskMessage | null {
  return (
    OptOutMessageSchema.safeParse(body).data ??
    StoppedAddressMessageSchema.safeParse(body).data ??
    null
  );
}

/**
 * Records what a route was told and queued, once its signature was checked: an address that opted
 * out of an organization's review requests, or one that bounced hard or complained, which no
 * organization asks again (issue #293).
 */
export async function recordDoNotAsk(
  message: DoNotAskMessage,
  { store }: { store: Store },
): Promise<"opted_out" | "stopped"> {
  if ("opt_out" in message) {
    await store.optOutAddress(message.opt_out.organization_id, message.opt_out.fingerprint);
    return "opted_out";
  }
  await store.stopAddress(message.stopped.fingerprint, message.stopped.reason);
  return "stopped";
}
