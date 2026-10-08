import { Link } from "react-router";

/** The wordmark. A plain link on the pages that sit outside the signed-in router's routes. */
export function Logo({ plain = false }: { plain?: boolean }) {
  const inner = (
    <>
      <span className="logo-mark" aria-hidden="true" />
      Nearcited
    </>
  );
  return plain ? (
    <a href="/" className="logo">
      {inner}
    </a>
  ) : (
    <Link to="/" className="logo">
      {inner}
    </Link>
  );
}
