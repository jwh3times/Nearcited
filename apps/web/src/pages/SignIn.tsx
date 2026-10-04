import { type FormEvent, useState } from "react";
import { ErrorNote } from "../components/ErrorNote";
import { supabase } from "../lib/supabase";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setSending(true);
    setError(null);
    const { error: failure } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setSending(false);
    if (failure) setError(failure);
    else setSentTo(email);
  }

  return (
    <main className="page page-narrow signin">
      <p className="wordmark">Nearcited</p>
      <h1>See where your business gets named</h1>
      <p className="lede">
        Track whether a location shows up when people ask an assistant or search Google for what it
        sells, and who shows up instead.
      </p>

      {sentTo ? (
        <p className="confirmation" role="status">
          Sign-in link sent to {sentTo}. Open it on this device.
        </p>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            Work email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" disabled={sending}>
            {sending ? "Sending link" : "Email me a sign-in link"}
          </button>
          <ErrorNote error={error} />
        </form>
      )}
    </main>
  );
}
