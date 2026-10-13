import type { DraftGiven, DraftKind, DraftRequest } from "@nearcited/shared";

/** Something that writes a draft. It only writes: whether the draft may be shown is checked by rule. */
export interface DraftWriter {
  /** The model that writes, as it is kept with the draft. Null for generated sample text. */
  model: string | null;
  write(request: DraftRequest): Promise<string>;
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
};

/**
 * The writer for sample data: text generated from what was given, with no model and no request
 * to anywhere. It stands where a draft goes so the rest can be seen working.
 */
export const sampleWriter: DraftWriter = {
  model: null,
  write: async ({ kind, given }) => SAMPLE[kind](given),
};
