import type { Me } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useMatch } from "react-router";
import { ErrorNote } from "./components/ErrorNote";
import { Shell } from "./components/Shell";
import { api } from "./lib/api";
import { useSession } from "./lib/session";
import { supabase } from "./lib/supabase";
import { readThroughBase, ViewingProvider } from "./lib/viewing";
import { AccountSettings } from "./pages/AccountSettings";
import { Audit } from "./pages/Audit";
import { LocationDetail } from "./pages/LocationDetail";
import { Locations } from "./pages/Locations";
import { Bot } from "./pages/legal/Bot";
import { Privacy } from "./pages/legal/Privacy";
import { Terms } from "./pages/legal/Terms";
import { Onboarding } from "./pages/Onboarding";
import { Operator } from "./pages/Operator";
import { OperatorPlan } from "./pages/OperatorPlan";
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
  const reading = useMatch("/operator/o/:organizationId/*");

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

  // The operator reading through a customer's account: the same pages, under another address.
  if (me.data.platform_role === "operator" && reading?.params.organizationId) {
    return <ReadThrough me={me.data} organizationId={reading.params.organizationId} />;
  }

  return (
    <Shell me={me.data} organization={organization}>
      <Routes>
        <Route index element={<Locations organization={organization} />} />
        <Route path="locations/:id" element={<LocationDetail />} />
        <Route
          path="settings"
          element={<AccountSettings organization={organization} email={me.data.email} />}
        />
        {/* Only an operator has this page. The server refuses everyone else whatever is shown. */}
        {me.data.platform_role === "operator" && <Route path="operator" element={<Operator />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

/**
 * A customer's account as the operator reads it: their sidebar and their pages, with nothing to
 * change but the plan's limits.
 */
function ReadThrough({ me, organizationId }: { me: Me; organizationId: string }) {
  const organization = useQuery({
    queryKey: ["operator-organization", organizationId],
    queryFn: () => api.operatorOrganization(organizationId),
  });

  if (organization.isPending) return <p className="page-narrow status">Loading</p>;
  if (organization.isError) {
    return (
      <main className="page-narrow">
        <ErrorNote error={organization.error} />
        <a href="/operator">Back to the operator view</a>
      </main>
    );
  }
  const base = readThroughBase(organizationId);
  return (
    <ViewingProvider value={{ base, readOnly: true }}>
      <Shell me={me} organization={organization.data}>
        <Routes>
          <Route path={base}>
            <Route index element={<Locations organization={organization.data} />} />
            <Route path="locations/:id" element={<LocationDetail />} />
            <Route
              path="plan"
              element={<OperatorPlan key={organizationId} organization={organization.data} />}
            />
            <Route path="*" element={<Navigate to={base} replace />} />
          </Route>
        </Routes>
      </Shell>
    </ViewingProvider>
  );
}
