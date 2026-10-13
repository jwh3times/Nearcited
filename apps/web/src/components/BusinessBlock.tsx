import {
  BLOCK_EXTRA_LABELS,
  type BlockLocation,
  buildBusinessBlock,
  type DetailsFix,
} from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCopy } from "../lib/copy";
import { detailsProof, detailsStatus } from "../lib/details";
import { formatDate, listOf, sourceLabel } from "../lib/format";
import { ErrorNote } from "./ErrorNote";

interface BusinessBlockProps {
  location: BlockLocation;
  /** Opens the tab where the location's details are kept. Left out for a reader who cannot edit. */
  onOpenSettings?: () => void;
  /** Where the fix stands: whether it was marked done, and what the scans saw around that. */
  fix?: DetailsFix | null;
  /** Called once the mark has changed. Left out for a reader who cannot mark it. */
  onMarked?: () => unknown;
}

/**
 * When the block was marked as on the page, what the scan since found, and what the answers did
 * before and since. Nothing until it is marked.
 */
export function DetailsProof({ fix, missing }: { fix: DetailsFix; missing: boolean }) {
  const status = detailsStatus(fix, missing, formatDate);
  const lines = detailsProof(fix);
  if (!status) return null;
  return (
    <p className="task-proof">
      {status}
      {lines && (
        <>
          <br />
          {lines.before}
          <br />
          {lines.since}
        </>
      )}
    </p>
  );
}

/**
 * The structured business details for a location, ready to paste: the fix for a page that has
 * none. Built here from the details on file, so it is always what they say now. It says what it
 * is for and promises nothing.
 */
export function BusinessBlock({ location, onOpenSettings, fix, onMarked }: BusinessBlockProps) {
  const block = buildBusinessBlock(location);
  const { copied, copy } = useCopy();
  const mark = useMutation({
    mutationFn: (acted: boolean) => api.setRecommendationActed(fix?.id ?? "", acted),
    onSuccess: onMarked,
  });
  const page = (location.website && sourceLabel(location.website)) ?? "your page";
  const missing = block.missing.map((extra) => BLOCK_EXTRA_LABELS[extra]);

  return (
    <div className="paste-block">
      <p>
        This block states who and where the business is in a form a crawler reads without guessing.
        It is built from the details on file here and nothing else. Whether it changes what an
        assistant answers is not known, so the next scans are what will show it.
      </p>
      <div className="paste-actions">
        <button type="button" className="secondary" onClick={() => copy(block.html)}>
          {copied === "yes" ? "Copied" : "Copy the block"}
        </button>
        <span role="status">
          {copied === "no" && "It could not be copied for you. Select it below and copy it."}
        </span>
      </div>
      {/* A browser may refuse the clipboard. The block is opened to be copied by hand. */}
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
      {fix && (
        <>
          <DetailsProof fix={fix} missing />
          {onMarked && (
            <div className="paste-actions">
              <button
                type="button"
                className={fix.acted_at ? "link" : "secondary"}
                disabled={mark.isPending}
                onClick={() => mark.mutate(!fix.acted_at)}
              >
                {fix.acted_at ? "Undo" : "Mark done"}
              </button>
              {!fix.acted_at && (
                <span>Once it is on the page, mark it done. The next scan will look for it.</span>
              )}
            </div>
          )}
          <ErrorNote error={mark.error} />
        </>
      )}
    </div>
  );
}
