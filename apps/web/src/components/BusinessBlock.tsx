import { BLOCK_EXTRA_LABELS, type BlockLocation, buildBusinessBlock } from "@nearcited/shared";
import { useState } from "react";
import { listOf, sourceLabel } from "../lib/format";

interface BusinessBlockProps {
  location: BlockLocation;
  /** Opens the tab where the location's details are kept. Left out for a reader who cannot edit. */
  onOpenSettings?: () => void;
}

/**
 * The structured business details for a location, ready to paste: the fix for a page that has
 * none. Built here from the details on file, so it is always what they say now. It says what it
 * is for and promises nothing.
 */
export function BusinessBlock({ location, onOpenSettings }: BusinessBlockProps) {
  const block = buildBusinessBlock(location);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const page = (location.website && sourceLabel(location.website)) ?? "your page";
  const missing = block.missing.map((extra) => BLOCK_EXTRA_LABELS[extra]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(block.html);
      setCopied("yes");
    } catch {
      // A browser may refuse the clipboard. The block is opened below to be copied by hand.
      setCopied("no");
    }
  }

  return (
    <div className="paste-block">
      <p>
        This block states who and where the business is in a form a crawler reads without guessing.
        It is built from the details on file here and nothing else. Whether it changes what an
        assistant answers is not known, so the next scans are what will show it.
      </p>
      <div className="paste-actions">
        <button type="button" className="secondary" onClick={copy}>
          {copied === "yes" ? "Copied" : "Copy the block"}
        </button>
        <span role="status">
          {copied === "no" && "It could not be copied for you. Select it below and copy it."}
        </span>
      </div>
      <details open={copied === "no" || undefined}>
        <summary className="paste-summary">See the block</summary>
        <pre>
          <code>{block.html}</code>
        </pre>
      </details>
      <p>
        Paste it into the HTML of {page}, the page on file for this location, in the head or the
        body. Most site builders have a custom-code block for this.
      </p>
      {missing.length > 0 && (
        <p>
          Not on file, so not in the block: {listOf(missing)}.{" "}
          {onOpenSettings && (
            <button type="button" className="link" onClick={onOpenSettings}>
              Add {missing.length === 1 ? "it" : "them"} in Settings
            </button>
          )}
        </p>
      )}
    </div>
  );
}
