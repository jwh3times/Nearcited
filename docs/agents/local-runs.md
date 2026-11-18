# Local runs

Traps on a development machine, most of them seen on the maintainer's Windows machine.

## Other projects share the machine

Other projects run their own local Supabase stacks and Workers on the same machine. Another
project's stack has held 54321 and 54322, and `taskkill /F /IM workerd.exe` once stopped every
project's `workerd`, not only Nearcited's.

- Stop a Worker by the PID listening on its own port (8787, 8788), never by image name.
- Before touching a container or port, check its name is `supabase_*_nearcited`; ask about anything
  else.
- Read a Supabase command's `Target:` line before believing its output: a bare `db push --dry-run`
  and `migration list` once read another project's database and reported a migration history that
  looked badly wrong.

## Looking at a page without a browser session

To screenshot a page of the web app headlessly on Windows:

- Serve the **built** app (`apps/web/dist`, from `pnpm check` or `pnpm build`) and canned `/api/*`
  responses from one small Node server on its own port. The dev server plus a separate stand-in API
  produced "could not be loaded" pages.
- Run Edge with `--headless=new --user-data-dir=<a fresh folder each run> --virtual-time-budget=7000
  --screenshot=<Windows path>`. Without a fresh profile it often exits without writing a file, so try
  two or three profiles and stop at the first that writes.
- Edge won't lay out narrower than about 500 px, so a phone width can't be checked this way. Say so
  when a view (a phone width, a signed-in page) wasn't seen.

## The companion's wiki

The private companion's wiki is turned on but has no pages yet, so cloning `<repo>.wiki.git` answers
"Repository not found" while the main repository answers with the same credentials. Report it as
empty, not unreachable. The first human follow-up whose steps go there creates the page in GitHub's
web interface before a push can work.
