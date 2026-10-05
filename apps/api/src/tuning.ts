import { resolveTuning } from "@nearcited/shared";
import bundled from "nearcited-tuning";

/**
 * The tuning this build runs on: the private values when the build had them, otherwise the public
 * defaults. Resolved once at startup, so a build with an invalid private file fails to start
 * instead of scoring on the wrong numbers.
 *
 * Import this only from the Worker entry point. Everything else takes the tuning as an argument,
 * which keeps it testable without the bundled file.
 */
export const activeTuning = resolveTuning(bundled);
