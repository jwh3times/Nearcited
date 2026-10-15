import {
  WORDPRESS_RETURN_PATH,
  type WordPressApproved,
  type WordPressCheck,
} from "@nearcited/shared";

/**
 * Connecting a location's WordPress site, as its owner is walked through it (issue #140). The
 * owner is assumed not to know what an application password is: the card says what they will see
 * and what to press, in WordPress's own words, read from WordPress 6.9's approval screen and
 * from its help page on 2026-10-14.
 */

/** WordPress's own help page on application passwords. */
export const PASSWORDS_HELP =
  "https://developer.wordpress.org/advanced-administration/security/application-passwords/";

/** What the owner will see, in order, once they press the button. */
export const CONNECT_STEPS = [
  "We check that your website runs WordPress, then take you to it. Sign in there as an administrator if WordPress asks you to.",
  "WordPress shows a page called “Authorize Application”, asking whether to give Nearcited access to your account. Choose “Yes, I approve of this connection”.",
  "You come back here and the site is connected. Nothing on it changes until you approve each change here. You can take the access away at any time, here or in WordPress under Users, Profile, Application Passwords.",
] as const;

/** What the card says where a site cannot be sent to approve, with what the owner can do. */
export const CHECK_WORDS: Record<Exclude<WordPressCheck["verdict"], "ready">, string> = {
  not_wordpress:
    "Your website does not look like a WordPress site, so Nearcited cannot publish to it. The page copy and the details block are still yours to paste in.",
  passwords_off:
    "Your website runs WordPress, but it has application passwords switched off, and that is how Nearcited connects. A security plugin or your host may have switched them off, and WordPress offers them only on a site served over https. On WordPress.com, the site's plan has to allow plugins. You can send the note below to whoever looks after your site.",
  unreachable:
    "Your website could not be reached just now. Try again in a while. If it keeps happening, check that the website under Settings is the address your site is at.",
  no_website: "Add this location's website under Settings first.",
};

/** A note the owner can forward to whoever looks after their site. */
export function passwordsNote(site: string): string {
  return `Could you turn on WordPress application passwords for ${site}? We use Nearcited for our local listings, and it connects to the site through them. WordPress explains them here: ${PASSWORDS_HELP}`;
}

/** Where the start of a connection is kept while the owner is away approving it. */
const STARTED = "nearcited-wordpress";

interface Started {
  state: string;
  location_id: string;
}

/**
 * Notes, in this tab only, that a connection was started from a location, with a code nobody
 * else knows. Coming back is believed only with the same code, so a link somebody else made
 * cannot connect their site to this account. False where the browser keeps nothing, and then
 * nothing is started.
 */
export function noteStarted(locationId: string): string | null {
  const state = crypto.randomUUID();
  try {
    sessionStorage.setItem(STARTED, JSON.stringify({ state, location_id: locationId }));
    return state;
  } catch {
    return null;
  }
}

/** What WordPress handed back, as the return page holds it. */
export type HandedBack =
  | { kind: "approved"; state: string; approved: WordPressApproved }
  | { kind: "declined"; state: string }
  | { kind: "nothing" };

/**
 * Reads what WordPress put on the address it sent its owner back to, and at once takes it off,
 * so the password is not kept in the browser's history, or sent on to anywhere the page links
 * to. Run before the app draws anything.
 */
export function takeHandedBack(location: Location = window.location): HandedBack {
  if (location.pathname !== WORDPRESS_RETURN_PATH) return { kind: "nothing" };
  const params = new URLSearchParams(location.search);
  try {
    window.history.replaceState(null, "", WORDPRESS_RETURN_PATH);
  } catch {
    // The page goes on; the address keeps what it had.
  }
  const state = params.get("state") ?? "";
  if (params.get("declined") === "1" || params.get("success") === "false") {
    return { kind: "declined", state };
  }
  const site_url = params.get("site_url");
  const user_login = params.get("user_login");
  const password = params.get("password");
  if (!state || !site_url || !user_login || !password) return { kind: "nothing" };
  return { kind: "approved", state, approved: { site_url, user_login, password } };
}

/** The location a connection was started from, when `state` is the code this tab noted. */
export function startedFrom(state: string): string | null {
  try {
    const kept = sessionStorage.getItem(STARTED);
    const started = kept ? (JSON.parse(kept) as Partial<Started>) : null;
    return started?.state && started.state === state && typeof started.location_id === "string"
      ? started.location_id
      : null;
  } catch {
    return null;
  }
}

/** Forgets the start of a connection once it is finished, either way. */
export function forgetStarted(): void {
  try {
    sessionStorage.removeItem(STARTED);
  } catch {
    // Nothing was kept.
  }
}

let held: HandedBack = { kind: "nothing" };

/** Takes what WordPress handed back off the address. Called once, before the app draws. */
export function keepHandedBack(): void {
  held = takeHandedBack();
}

/** What WordPress handed back when the app was opened. */
export const handedBack = (): HandedBack => held;
