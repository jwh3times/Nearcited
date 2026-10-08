import { type ReactNode, useEffect } from "react";
import { LegalLinks } from "../../components/LegalLinks";
import { Logo } from "../../components/Logo";
import { POLICIES_UPDATED } from "../../lib/legal";
import { useTheme } from "../../lib/theme";

interface LegalPageProps {
  title: string;
  /** One or two sentences that say what the page covers, in plain words. */
  summary: string;
  children: ReactNode;
}

/** The frame the policies share: readable signed out, with the same header and footer. */
export function LegalPage({ title, summary, children }: LegalPageProps) {
  useTheme();
  useEffect(() => {
    const before = document.title;
    document.title = `${title} | Nearcited`;
    return () => {
      document.title = before;
    };
  }, [title]);

  return (
    <>
      <header className="audit-head">
        <Logo plain />
        <span>Last updated {POLICIES_UPDATED}</span>
      </header>
      <main className="prose">
        <h1>{title}</h1>
        <p className="lede">{summary}</p>
        {children}
      </main>
      <footer className="legal-foot">
        <LegalLinks />
      </footer>
    </>
  );
}
