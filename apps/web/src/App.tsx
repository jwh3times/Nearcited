import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useMatch } from "react-router";
import { ErrorNote } from "./components/ErrorNote";
import { Shell } from "./components/Shell";
import { api } from "./lib/api";
import { useSession } from "./lib/session";
import { supabase } from "./lib/supabase";
import { AccountSettings } from "./pages/AccountSettings";
import { Audit } from "./pages/Audit";
import { LocationDetail } from "./pages/LocationDetail";
import { Locations } from "./pages/Locations";
import { Bot } from "./pages/legal/Bot";
import { Privacy } from "./pages/legal/Privacy";
import { Terms } from "./pages/legal/Terms";
import { Onboarding } from "./pages/Onboarding";
import { SignIn } from "./pages/SignIn";

export function App() {
  const session = useSession();
  const audit = useMatch("/audit/:token");
  const { pathname } = useLocation();

  // A shareable audit is for someone who has no account, so it comes before everything else.
  if (audit?.params.token) return <Audit token={audit.params.token} />;
  // So do the policies, which have to be readable before signing in.
  if (pathname === "/privacy") return <Privacy />;
  if (pathname === "/terms") return <Terms />;
  if (pathname === "/bot") return <Bot />;

  if (!supabase) {
    return (
      <main className="page-narrow">
        <h1>Supabase is not configured</h1>
        <p>
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in{" "}
          <code>apps/web/.env.local</code>, then restart the dev server.
        </p>
      </main>
    );
  }
  if (session === undefined) return <p className="page-narrow status">Loading</p>;
  if (!session) return <SignIn />;
  return <SignedIn />;
}

function SignedIn() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (me.isPending) return <p className="page-narrow status">Loading</p>;
  if (me.isError) {
    return (
      <main className="page-narrow">
        <ErrorNote error={me.error} />
      </main>
    );
  }

  // One organization per user for now. A switcher belongs in the sidebar when that changes.
  const organization = me.data.organizations[0];
  // The first run has nothing to put in a sidebar, so it gets the whole page.
  if (!organization) return <Onboarding sampleData={me.data.sample_data} />;

  return (
    <Shell me={me.data} organization={organization}>
      <Routes>
        <Route index element={<Locations organization={organization} />} />
        <Route path="locations/:id" element={<LocationDetail />} />
        <Route
          path="settings"
          element={<AccountSettings organization={organization} email={me.data.email} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
