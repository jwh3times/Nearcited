/**
 * `nearcited-tuning` is the file scripts/prepare-tuning.mjs writes, apps/api/.tuning/tuning.json.
 * Wrangler maps the name to it (see "alias" in wrangler.jsonc). It is unknown on purpose:
 * `resolveTuning` validates it.
 */
declare module "nearcited-tuning" {
  const bundled: unknown;
  export default bundled;
}
