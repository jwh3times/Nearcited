---
status: accepted
---

# Private tuning is data, and all code stays public

The prompts, sample counts and score weights are the part of the product a competitor would copy,
so they are kept out of this public repository (decided in issue #17). We keep them as **values in
a data file** in the private companion repository, `private/tuning.json`, and keep every line of
code that uses them here. The public repository defines the schema (`TuningSchema` in
`packages/shared/src/tuning.ts`) and a set of placeholder defaults. At build time
`scripts/prepare-tuning.mjs` gives the Worker the private file when it is checked out and a marker
for the defaults when it is not.

We chose this because what needs protecting is values, not algorithms, and because it is the only
option that leaves a public clone, CI and the lockfile untouched by the private side.

## Considered options

- **A private workspace package** under `private/`. Rejected: `pnpm-lock.yaml` would differ between
  machines with and without the checkout, `--frozen-lockfile` would fail in CI, and the lockfile
  would publish the private package's name and dependencies.
- **A private npm package.** Rejected: a public clone could not install.
- **A build-time alias that swaps a public module for a private one.** Rejected for now: private
  code would be compiled only on a maintainer's machine and at deploy, never in CI. It remains the
  fallback if a whole method, not only its numbers, ever has to be private.
- **Loading tuning at runtime from Workers KV or a secret.** Rejected for now: values could change
  without a deploy, but would lose review and history, and a secret is limited to a few kilobytes.
  It can be added later on the same schema.

## Consequences

- **Live scans refuse to run on the default tuning.** A build without the private file would send
  placeholder prompts and score on guessed weights, then store the result as a measurement, which
  is the same failure as mock data passing as real. `liveScansUnavailable` fails every scan with a
  reason instead. Mock mode runs on the defaults.
- **The tuning never reaches the browser.** The web app's bundle is public. It may import types
  from the tuning module and nothing else; scores are computed in the Worker.
- **An invalid private file stops the deploy; it never falls back to the defaults.** The schema is
  applied by `packages/db/test/private-tuning.test.ts` wherever the checkout exists, and again by
  the Worker at startup.
- **A new private value starts as a public schema change.** Add the field and its default here,
  then the real value in the private file. The schema's shape is public; only the values are not.
- **Deploying needs the private checkout.** `.github/workflows/deploy.yml` fetches it with a
  read-only deploy key held in repository secrets.
- Deploying this AGPL code together with private values is the copyright holder's right, and is
  one reason outside pull requests are not merged. Anyone else who hosts a modified copy must
  still publish their changes.
