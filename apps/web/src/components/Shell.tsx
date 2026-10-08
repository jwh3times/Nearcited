import type { Me, Organization } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useLocation, useMatch } from "react-router";
import { api } from "../lib/api";
import { placeOf, useTrends } from "../lib/locations";
import { supabase } from "../lib/supabase";
import { useTheme } from "../lib/theme";
import { Logo } from "./Logo";

interface ShellProps {
  me: Me;
  organization: Organization;
  children: ReactNode;
}

/** The signed-in frame: every location in the sidebar, the page beside it. */
export function Shell({ me, organization, children }: ShellProps) {
  const [theme, toggleTheme] = useTheme();
  const { search } = useLocation();
  const open = useMatch("/locations/:id")?.params.id;
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const trends = useTrends(locations.data ?? []);
  const initials = (me.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <Logo />
        <div className="org-card">
          <span className="nav-label">Organization</span>
          <strong>{organization.name}</strong>
        </div>

        <nav className="nav" aria-label="Locations">
          <Link to="/" className="nav-row" aria-current={open ? undefined : "page"}>
            <span>All locations</span>
            {locations.data && (
              <span className="mono">
                {locations.data.length}/{organization.max_locations}
              </span>
            )}
          </Link>
          <span className="nav-label">Locations</span>
          {locations.data?.map((location) => {
            const trend = trends.get(location.id) ?? [];
            const score = trend[trend.length - 1]?.score;
            return (
              <Link
                key={location.id}
                // The tab stays put when moving between locations.
                to={`/locations/${location.id}${open ? search : ""}`}
                className="nav-row"
                aria-current={open === location.id ? "page" : undefined}
              >
                <span>
                  <span className="nav-name">{location.name}</span>
                  <span className="nav-place">{placeOf(location)}</span>
                </span>
                <span className="mono">{score ?? "—"}</span>
              </Link>
            );
          })}
          <Link to="/?add=1" className="nav-add">
            + Add location
          </Link>
        </nav>

        <div className="sidebar-foot">
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <div>
              <span className="email">{me.email}</span>
              <button type="button" className="link" onClick={() => supabase?.auth.signOut()}>
                Sign out
              </button>
            </div>
          </div>
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            {theme === "dark" ? (
              <>
                Light mode <span aria-hidden="true">☀</span>
              </>
            ) : (
              <>
                Dark mode <span aria-hidden="true">☾</span>
              </>
            )}
          </button>
        </div>
      </aside>

      <div className="main">
        {me.sample_data && (
          <p className="sample-banner">
            Scans are returning generated sample data, not real measurements.
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
