import { useEffect } from "react";

/**
 * Asks search engines to leave the page alone while it is shown: for a page reached by a link that
 * is the only key to it, such as a shareable audit or a link to opt out.
 */
export function useNoIndex() {
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    return () => robots.remove();
  }, []);
}
