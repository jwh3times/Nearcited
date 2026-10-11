import { ALLOWANCE_KINDS } from "@nearcited/shared";
import { afterAll, beforeAll } from "vitest";

/**
 * No kind of allowance exists yet, so a group of tests that needs one makes two for as long as
 * it runs: one that is counted, and one that is included or it is not.
 */
export function useSampleAllowances() {
  beforeAll(() => {
    ALLOWANCE_KINDS.sample_count = { counted: true, name: "Sample pieces of work" };
    ALLOWANCE_KINDS.sample_access = { counted: false, name: "Sample access" };
  });
  afterAll(() => {
    Reflect.deleteProperty(ALLOWANCE_KINDS, "sample_count");
    Reflect.deleteProperty(ALLOWANCE_KINDS, "sample_access");
  });
}
