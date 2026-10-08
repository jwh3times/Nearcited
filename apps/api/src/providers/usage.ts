import type { ProviderUsage, Surface } from "@nearcited/shared";
import type { CallUsage } from "./types";

/**
 * Adds up what a scan's calls used, one total per surface and model. A scan makes many calls at
 * once, and a model can change between them when a provider falls back to another.
 */
export function usageTally() {
  const totals = new Map<string, ProviderUsage>();
  return {
    /** A callback for one surface's checks, to hand to its provider as `onUsage`. */
    on(surface: Surface) {
      return (call: CallUsage) => {
        const key = `${surface}|${call.model}`;
        const total = totals.get(key) ?? {
          surface,
          model: call.model,
          calls: 0,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          searches: 0,
        };
        total.calls += 1;
        total.input_tokens += call.input_tokens;
        total.cached_input_tokens += call.cached_input_tokens;
        total.output_tokens += call.output_tokens;
        total.searches += call.searches;
        totals.set(key, total);
      };
    },
    /**
     * What has been used since the last time this was asked, and forgets it, so the same call
     * is never handed over twice. Empty when nothing reported, as with generated data.
     */
    take(): ProviderUsage[] {
      const taken = [...totals.values()];
      totals.clear();
      return taken;
    },
  };
}
