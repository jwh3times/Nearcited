import type { AnswerSubdomain } from "@nearcited/shared";

/** How often the card asks again while the worker is waiting for the record or the certificate. */
export const WAITING_MS = 15_000;

/** True while the worker is still to find the record or see the certificate issued. */
export const settingUp = (subdomain: AnswerSubdomain): boolean =>
  subdomain.status === "working" && subdomain.live_at === null;

/** What the card says, kept together so the tests and the page agree. */
export const HOSTED_WORDS = {
  title: "Pages on your own domain",
  about:
    "Your site's builder offers no way for Nearcited to publish to it. Nearcited can host the pages written for your prompts instead, on a subdomain of your own domain: a name in front of it, such as answers.yourbusiness.com. You add one record where your domain is managed, once, and each page goes up only after somebody here approves it.",
  label: "Subdomain",
  hint: "One word: letters, digits and hyphens.",
  makeIt: "Set up the subdomain",
  making: "Setting it up",
  onlyManagers: "Only your organization's owner or an admin can set this up.",
  noWebsite: "Pages go on a subdomain of your website, and there is no website on file.",
  unavailable: "Pages on your own domain cannot be set up here yet.",
  record: "Add this record where your domain's DNS is managed:",
  wholeName: (hostname: string) =>
    `Some providers want the whole name instead: ${hostname}. Leave anything else they ask for as it is.`,
  cloudflare:
    "If your domain is on Cloudflare, set the record's proxy status to DNS only (the grey cloud).",
  where: "Where to add a record, at the common providers",
  waiting: (until: string) =>
    `Waiting for the record. Nearcited looks for it every few minutes until ${until}; a new record can take up to an hour to be seen.`,
  proxied:
    "The record was found, but it is proxied by Cloudflare, which hides where it points. Set its proxy status to DNS only (the grey cloud).",
  elsewhere:
    "The name points somewhere else. Check that the record's target is exactly the one above.",
  registering:
    "The record is in place. The certificate that keeps the pages secure is being set up; this usually takes a few minutes.",
  live: (hostname: string) => `Working. Pages approved here go up at ${hostname}.`,
  linked: "Your home page links to it, so assistants reading your site can find the pages.",
  link: "Add a link to it on your home page, so assistants reading your site find the pages. Nearcited ticks this off by itself once the link is there:",
  copyLink: "Copy the link",
  moved:
    "Your website is now on another domain, so no new pages are offered here. Pages already published stay up. Remove the subdomain on the Connections page, or put the website back under Settings.",
  manage: "The subdomain is removed on the",
  paused: "Your plan no longer includes pages on your own domain. Nothing new is published here.",
  removing: "Being removed.",
} as const;

/** The link an owner pastes on their home page. */
export const homeLink = (hostname: string): string =>
  `<a href="https://${hostname}/">Answers to common questions</a>`;
