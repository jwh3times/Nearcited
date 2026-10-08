import { type FormEvent, useState } from "react";
import { z } from "zod";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { LegalLinks } from "../components/LegalLinks";
import { Logo } from "../components/Logo";
import { useFormErrors } from "../lib/form";
import { supabase } from "../lib/supabase";

const EmailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address")
    .pipe(z.email("Enter an email address, like you@company.com")),
});

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  const form$ = useFormErrors(EmailSchema, { email });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !form$.check()) return;
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
    <main className="signin">
      <div className="signin-panel">
        <Logo plain large />
        <h1 className="hero">
          When people ask AI who to call, <em>is it you?</em>
        </h1>
        {/* An illustration of what the product shows, with an invented business. It says so. */}
        <figure className="card sample-card">
          <figcaption className="mono muted">
            Example · ChatGPT · “best emergency plumber in Asheville”
          </figcaption>
          <p className="display">
            For a burst pipe at night I'd start with <mark>Blue Ridge Plumbing</mark>, which answers
            around the clock and has the most recent reviews.
          </p>
          <div className="split small muted">
            <span>Named in 5 of the last 7 answers</span>
            <span className="mono">Best #2</span>
          </div>
        </figure>
        <div className="stack-tight">
          <p className="small muted">
            Nearcited asks the assistants what your customers ask, every day, and shows whether your
            business is named, who is named instead, and where the answers come from.
          </p>
          <LegalLinks />
        </div>
      </div>

      <div className="signin-form">
        <div>
          {sentTo ? (
            <div className="card sent-card" role="status">
              <h2 className="h-sm">Check your inbox</h2>
              <p>
                We sent a sign-in link to <strong>{sentTo}</strong>. Open it on this device.
              </p>
              <button type="button" className="go" onClick={() => setSentTo(null)}>
                Use another email
              </button>
            </div>
          ) : (
            <>
              <div>
                <h2 className="h-lg">Sign in</h2>
                <p className="muted">We'll email you a link. No password.</p>
              </div>
              <form onSubmit={submit} noValidate>
                <Field
                  label="Work email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  error={form$.error("email")}
                  onBlur={() => form$.touch("email")}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <button type="submit" className="wide" disabled={sending}>
                  {sending ? "Sending link" : "Email me a sign-in link"}
                </button>
                <ErrorNote error={error} />
                <p className="small muted">
                  By signing in you agree to the <a href="/terms">terms of service</a> and the{" "}
                  <a href="/privacy">privacy policy</a>.
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
