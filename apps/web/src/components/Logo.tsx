import { Link } from "react-router";

/** The wordmark. A plain link on the pages that sit outside the signed-in router's routes. */
export function Logo({ plain = false, large = false }: { plain?: boolean; large?: boolean }) {
  const className = large ? "logo logo-lg" : "logo";
  const inner = (
    <>
      <span className="logo-mark" aria-hidden="true" />
      Nearcited
    </>
  );
  return plain ? (
    <a href="/" className={className}>
      {inner}
    </a>
  ) : (
    <Link to="/" className={className}>
      {inner}
    </Link>
  );
}
