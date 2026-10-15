import { DRAFT_KINDS, type DraftGiven, type DraftKind, type DraftRequest } from "@nearcited/shared";
import type { CallUsage } from "../providers/types";

/** Something that writes a draft. It only writes: whether the draft may be shown is checked by rule. */
export interface DraftWriter {
  /** The model that writes, as it is kept with the draft. Null for generated sample text. */
  model: string | null;
  /** The kinds of draft it can write. */
  kinds: readonly DraftKind[];
  /**
   * Writes one draft and returns its text. `onUsage` is called once for each call it is charged
   * for, including one whose text is then thrown away.
   */
  write(request: DraftRequest, onUsage?: (usage: CallUsage) => void): Promise<string>;
}

const place = ({ city, region }: DraftGiven) => (region ? `${city}, ${region}` : city);

const SAMPLE: Record<DraftKind, (given: DraftGiven) => string> = {
  note: (given) =>
    [
      "Hello,",
      `I run ${given.name} in ${place(given)}. ${given.what_we_do}`,
      `Your page on ${given.host}${given.url ? ` (${given.url})` : ""} is one people are sent to when they ask for a business like ours, and we are not on it. Would you consider adding us?`,
      given.website ? `There is more about us at ${given.website}.` : null,
      "Thank you for your time.",
    ]
      .filter((line) => line !== null)
      .join("\n\n"),
  listing: (given) =>
    [
      `${given.name} is in ${place(given)}.`,
      given.what_we_do,
      given.website ? `More at ${given.website}.` : null,
    ]
      .filter((line) => line !== null)
      .join(" "),
  page: (given) =>
    [
      `${given.prompt ?? given.name}: ${given.name} in ${place(given)}`,
      `${given.name} is in ${place(given)}. ${given.what_we_do}`,
      "## What we do",
      given.what_we_do,
      "## Where to find us",
      `${given.name} serves ${place(given)}.`,
    ].join("\n\n"),
};

/**
 * The writer for sample data: text generated from what was given, with no model and no request
 * to anywhere. It stands where a draft goes so the rest can be seen working.
 */
export const sampleWriter: DraftWriter = {
  model: null,
  kinds: DRAFT_KINDS,
  write: async ({ kind, given }) => SAMPLE[kind](given),
};
