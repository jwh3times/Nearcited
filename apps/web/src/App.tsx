import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router";
import { ErrorNote } from "./components/ErrorNote";
import { Shell } from "./components/Shell";
import { api } from "./lib/api";
import { useSession } from "./lib/session";
import { supabase } from "./lib/supabase";
import { LocationDetail } from "./pages/LocationDetail";
import { Locations } from "./pages/Locations";
import { Onboarding } from "./pages/Onboarding";
import { SignIn } from "./pages/SignIn";

export function App() {
  const session = useSession();

  if (!supabase) {
    return (
      <main className="page page-narrow">
        <h1>Supabase is not configured</h1>
        <p>
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in{" "}
          <code>apps/web/.env.local</code>, then restart the dev server.
        </p>
      </main>
    );
  }
  if (session === undefined) return <p className="page status">Loading</p>;
  if (!session) return <SignIn />;
  return <SignedIn />;
}

function SignedIn() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (me.isPending) return <p className="page status">Loading</p>;
  if (me.isError) {
    return (
      <main className="page page-narrow">
        <ErrorNote error={me.error} />
      </main>
    );
  }

  // One organization per user for now. A switcher belongs in the header when that changes.
  const organization = me.data.organizations[0];

  return (
    <Shell me={me.data} organization={organization}>
      {organization ? (
        <Routes>
          <Route index element={<Locations organization={organization} />} />
          <Route path="locations/:id" element={<LocationDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Onboarding />
      )}
    </Shell>
  );
}
