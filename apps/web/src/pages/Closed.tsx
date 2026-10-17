/**
 * Where an owner lands once they have asked for their account to be closed. They are signed out
 * already, so it reads nothing: the worker closes the account and emails them when it has.
 */
export function Closed() {
  return (
    <main className="page-narrow">
      <h1>Your account is being closed</h1>
      <p>
        Nearcited is deleting your organization and everything in it, then your sign-in. It takes a
        minute or two, and an email to your address says when it is done.
      </p>
      <p>
        <a href="/">Back to Nearcited</a>
      </p>
    </main>
  );
}
