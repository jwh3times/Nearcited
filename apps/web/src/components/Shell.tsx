import type { Me, Organization } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation, useMatch } from "react-router";
import { api } from "../lib/api";
import { placeOf, useTrends } from "../lib/locations";
import { supabase } from "../lib/supabase";
import { useTheme } from "../lib/theme";
import { useViewing } from "../lib/viewing";
import { LegalLinks } from "./LegalLinks";
import { Logo } from "./Logo";

interface ShellProps {
  me: Me;
  /** The organization shown: the reader's own, or one the operator is reading through. */
  organization: Organization;
  children: ReactNode;
}

/** The signed-in frame: every location in the sidebar, the page beside it. */
export function Shell({ me, organization, children }: ShellProps) {
  const [theme, toggleTheme] = useTheme();
  const { search, pathname } = useLocation();
  // On a small screen the sidebar is a bar with a menu. Going somewhere closes it.
  const [menuOpen, setMenuOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page changing is the trigger
  useEffect(() => setMenuOpen(false), [pathname, search]);
  const { base, readOnly } = useViewing();
  const open = useMatch(`${base}/locations/:id`)?.params.id;
  const onSettings = useMatch("/settings") !== null;
  const onOperator = useMatch("/operator") !== null;
  const onPlan = useMatch(`${base}/plan`) !== null;
  const home = base || "/";
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });
  const trends = useTrends(locations.data ?? []);
  const initials = (me.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="shell">
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <Logo />
        <button
          type="button"
          className="secondary menu-button"
          aria-expanded={menuOpen}
          aria-controls="sidebar-body"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
        <div className="sidebar-body" id="sidebar-body">
          <div className="org-card">
            <span className="nav-label">Organization</span>
            <strong>{organization.name}</strong>
          </div>

          <nav className="nav" aria-label="Locations">
            <Link
              to={home}
              className="nav-row"
              aria-current={open || onSettings || onOperator || onPlan ? undefined : "page"}
            >
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
                  to={`${base}/locations/${location.id}${open ? search : ""}`}
                  className="nav-row"
                  aria-current={open === location.id ? "page" : undefined}
                >
                  <span>
                    <span className="nav-name">{location.name}</span>
                    <span className="nav-place">
                      {placeOf(location)}
                      {location.paused_by_plan ? " · paused" : ""}
                    </span>
                  </span>
                  <span className="mono">{score ?? "—"}</span>
                </Link>
              );
            })}
            {!readOnly && (
              <Link to="/?add=1" className="nav-add">
                + Add location
              </Link>
            )}
          </nav>

          <div className="sidebar-foot">
            {me.platform_role === "operator" && (
              <Link
                to="/operator"
                className="nav-row"
                aria-current={onOperator || readOnly ? "page" : undefined}
              >
                <span>Operator</span>
              </Link>
            )}
            {!readOnly && (
              <Link
                to="/settings"
                className="nav-row"
                aria-current={onSettings ? "page" : undefined}
              >
                <span>Account settings</span>
              </Link>
            )}
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
            <LegalLinks />
          </div>
        </div>
      </aside>

      <div className="main">
        {readOnly && (
          <p className="operator-bar" role="status">
            <span>
              You are reading <strong>{organization.name}</strong> as the operator. Nothing here can
              be changed but its <Link to={`${base}/plan`}>plan and limits</Link>.
            </span>
            <Link to="/operator">Back to the operator view</Link>
          </p>
        )}
        {(me.sample_data || organization.is_test) && (
          <p className="sample-banner">
            Scans are returning generated sample data, not real measurements.
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
