import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "nearcited:theme";

function stored(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // Storage can be blocked. The choice then lasts for the visit.
    return null;
  }
}

/** The saved choice, or what the device prefers. `index.html` applies the same rule before paint. */
export function currentTheme(): Theme {
  return (
    stored() ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

/** The theme and a way to flip it. The choice is kept in this browser. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () =>
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(KEY, next);
      } catch {}
      return next;
    });
  return [theme, toggle];
}
