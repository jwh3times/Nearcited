import { sourceLabel } from "../lib/format";

/**
 * The pages an answer cited. Providers' terms require these to be shown, visible and clickable,
 * wherever the answer is, so do not drop this list when changing how excerpts are displayed.
 */
export function Sources({ urls }: { urls: string[] }) {
  const links = urls.flatMap((url) => {
    const label = sourceLabel(url);
    return label ? [{ url, label }] : [];
  });
  if (links.length === 0) return null;
  return (
    <p className="sources">
      Sources:{" "}
      {links.map((link, index) => (
        <span key={link.url}>
          {index > 0 && ", "}
          <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">
            {link.label}
          </a>
        </span>
      ))}
    </p>
  );
}
