import { useState } from "react";

/**
 * Putting text on the clipboard, and whether it got there. A browser may refuse, so "no" is a
 * state the page has to answer: the text is shown to be copied by hand.
 */
export function useCopy() {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }
  return { copied, copy };
}
