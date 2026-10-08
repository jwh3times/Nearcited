import { CONTACT_EMAIL, LEGAL_PAGES } from "../lib/legal";

/**
 * Links to the policies and a way to reach us. Plain links, not router links: these pages are
 * read signed out as often as signed in, and a full load is the same either way.
 */
export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Policies">
      {LEGAL_PAGES.map((page) => (
        <a key={page.path} href={page.path}>
          {page.label}
        </a>
      ))}
      <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
    </nav>
  );
}
