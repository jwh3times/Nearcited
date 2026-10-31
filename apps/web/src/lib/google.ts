import { GOOGLE_RETURN_PATH } from "@nearcited/shared";

/**
 * Connecting a Google Analytics account, as its owner is walked through it (issue #144). The owner
 * signs in on Google's own screen and Google sends them back to the app.
 */

export const GOOGLE_WORDS = {
  title: "Connect Google Analytics",
  about:
    "Where Google Analytics is on a location's website, Nearcited can read how many sessions arrived from AI assistants such as ChatGPT, with nothing to paste. Sign in with Google once. Nearcited asks only to read your Analytics, and can change nothing in it.",
  button: "Sign in with Google",
  starting: "Taking you to Google",
  noStorage:
    "This browser would not keep the sign-in going. Allow this site to store data and try again.",
  matched:
    "Each location is matched to the property that measures its website. Where several locations share a website, the first made is.",
  matchedTitle: "Properties, and the location each is counted for",
  noLocation: "No location's website is measured by it",
  remove: (label: string) =>
    `Removing ${label} stops Nearcited reading from it, takes back the access it was given at Google and deletes the sign-in here. It cannot be undone: connecting again means signing in again. What was counted stays on each location's page.`,
  returnTitle: "Your Google Analytics",
  connecting: "Connecting your Google Analytics",
  nothing: "There is nothing to finish here.",
  notFromHere:
    "This was not started from this browser tab, so nothing was connected. Start again from the Connections page.",
  declined: "You chose not to connect it, so nothing was connected.",
  back: "Back to Connections",
} as const;

/** Where the start of a sign-in is kept while the owner is away at Google. */
const STARTED = "nearcited-google";

interface Started {
  state: string;
  organization_id: string;
}

/**
 * Notes, in this tab only, that a sign-in was started for an organization, with the `state` of the
 * address Google was asked to show. Coming back is believed only with the same one. False where the
 * browser keeps nothing, and then nothing is started.
 */
export function noteGoogleStarted(organizationId: string, address: string): boolean {
  try {
    const state = new URL(address).searchParams.get("state");
    if (!state) return false;
    const started: Started = { state, organization_id: organizationId };
    sessionStorage.setItem(STARTED, JSON.stringify(started));
    return true;
  } catch {
    return false;
  }
}

/** What Google handed back, as the return page holds it. */
export type GoogleHandedBack =
  | { kind: "agreed"; code: string; state: string }
  | { kind: "declined"; state: string }
  | { kind: "nothing" };

/**
 * Reads what Google put on the address it sent its owner back to, and at once takes it off, so the
 * code is not kept in the browser's history, or sent on to anywhere the page links to. Run before
 * the app draws anything.
 */
export function takeGoogleHandedBack(location: Location = window.location): GoogleHandedBack {
  if (location.pathname !== GOOGLE_RETURN_PATH) return { kind: "nothing" };
  const params = new URLSearchParams(location.search);
  try {
    window.history.replaceState(null, "", GOOGLE_RETURN_PATH);
  } catch {
    // The page goes on; the address keeps what it had.
  }
  const state = params.get("state");
  if (!state) return { kind: "nothing" };
  if (params.get("error")) return { kind: "declined", state };
  const code = params.get("code");
  return code ? { kind: "agreed", code, state } : { kind: "nothing" };
}

/** The organization a sign-in was started for, when `state` is the one this tab noted. */
export function googleStartedFrom(state: string): string | null {
  try {
    const kept = sessionStorage.getItem(STARTED);
    const started = kept ? (JSON.parse(kept) as Partial<Started>) : null;
    return started?.state === state && typeof started.organization_id === "string"
      ? started.organization_id
      : null;
  } catch {
    return null;
  }
}

/** Forgets the start of a sign-in once it is finished, either way. */
export function forgetGoogleStarted(): void {
  try {
    sessionStorage.removeItem(STARTED);
  } catch {
    // Nothing was kept.
  }
}

let held: GoogleHandedBack = { kind: "nothing" };

/** Takes what Google handed back off the address. Called once, before the app draws. */
export function keepGoogleHandedBack(): void {
  held = takeGoogleHandedBack();
}

/** What Google handed back when the app was opened. */
export const googleHandedBack = (): GoogleHandedBack => held;
