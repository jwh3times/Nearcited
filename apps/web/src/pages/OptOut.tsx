import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { optOutPage } from "../lib/opt-out";
import { useTheme } from "../lib/theme";

/**
 * Where the link to opt out in a review request lands: a customer of a business, with no account.
 * Nothing is recorded until they click, so a mail scanner opening the link changes nothing. The
 * click opts their address out of every location of the business that sent the email.
 */
export function OptOut({ token }: { token: string }) {
  const optOut = useMutation({ mutationFn: () => api.optOut(token) });
  const page = optOutPage(optOut.status, optOut.error);

  // The link is the only key to this page, so ask search engines to leave it alone.
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    return () => robots.remove();
  }, []);

  useTheme();

  return (
    <main className="page-narrow">
      <Logo plain />
      <h1>{page.heading}</h1>
      <p>{page.body}</p>
      {page.button && (
        <button type="button" onClick={() => optOut.mutate()}>
          {page.button}
        </button>
      )}
    </main>
  );
}
