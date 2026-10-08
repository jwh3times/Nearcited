/** Who the policies are made by and how to reach them. Changed here, they change on every page. */
export const OPERATOR = "Jerry Holland";
/** Help with the product, the terms, and a site operator writing about the crawler. */
export const CONTACT_EMAIL = "support@nearcited.com";
/** Requests about personal information: a copy, a correction, a deletion. */
export const PRIVACY_EMAIL = "privacy@nearcited.com";
export const GOVERNING_LAW = "North Carolina";
/** When the policies below last changed. Update it with any change to their wording. */
export const POLICIES_UPDATED = "October 8, 2026";

/** The public pages that need no sign-in, by path. */
export const LEGAL_PAGES = [
  { path: "/privacy", label: "Privacy" },
  { path: "/terms", label: "Terms" },
  { path: "/bot", label: "Our crawler" },
] as const;
