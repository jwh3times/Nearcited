import type { Me, Organization } from "@nearcited/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { supabase } from "../lib/supabase";

interface ShellProps {
  me: Me;
  organization: Organization | undefined;
  children: ReactNode;
}

export function Shell({ me, organization, children }: ShellProps) {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="wordmark">
          Nearcited
        </Link>
        {organization && <span className="topbar-org">{organization.name}</span>}
        <span className="topbar-user">
          {me.email}
          <button type="button" className="link" onClick={() => supabase?.auth.signOut()}>
            Sign out
          </button>
        </span>
      </header>
      {me.sample_data && (
        <p className="sample-banner">
          Scans are returning generated sample data, not real measurements.
        </p>
      )}
      <main className="page">{children}</main>
    </>
  );
}
