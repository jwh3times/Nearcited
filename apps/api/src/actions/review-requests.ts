import { approvedWording, siteName } from "@nearcited/shared";
import { secretBytes } from "../connections/seal";
import type { Store } from "../store/types";

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
const base64Url = (bytes: ArrayBuffer) =>
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
    ["sign"],
  );
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
  const sign = (key: CryptoKey, text: string) =>
    crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return {
    fingerprint: async (address) => hex(await sign(fingerprintKey, address.trim().toLowerCase())),
    optOutToken: async (organizationId, fingerprint) => {
      const carried = `${organizationId}.${fingerprint}`;
      return `${carried}.${base64Url(await sign(linkKey, carried))}`;
    },
  };
}

/**
 * Proposes asking each ready customer contact no request was proposed for yet, in the wording its
 * location's owner approved. A location with no review form left on the site chosen proposes
 * nothing, and its contacts wait. Returns how many were proposed, approved by standing permission
 * as they were made included.
 */
export async function proposeReviewRequests({
  store,
  asking,
}: {
  store: Store;
  asking: Asking;
}): Promise<number> {
  const wordings = new Map<string, { wording: string; site: string } | null>();
  const wordingOf = async (locationId: string) => {
    if (!wordings.has(locationId)) {
      const [location, settings, listings] = await Promise.all([
        store.getLocation(locationId),
        store.getLocationReviewRequests(locationId),
        store.listListings(locationId),
      ]);
      const email =
        location && settings ? approvedWording(location.name, settings.site, listings) : null;
      wordings.set(
        locationId,
        email && settings ? { wording: email.body, site: settings.site } : null,
      );
    }
    return wordings.get(locationId) ?? null;
  };

  let proposed = 0;
  for (const contact of await store.listContactsToAsk()) {
    const kept = await wordingOf(contact.location_id);
    if (!kept) continue;
    const outcome = await store.proposeReviewRequest(
      contact.id,
      await asking.keys.fingerprint(contact.address),
      `Ask ${contact.masked} for a review on ${siteName(kept.site)}`,
      kept.wording,
    );
    if (outcome === "proposed" || outcome === "approved") proposed++;
  }
  return proposed;
}
