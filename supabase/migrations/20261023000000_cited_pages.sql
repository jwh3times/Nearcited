-- The cited-page check (docs/adr/0027), kept with the scan that made it.
--
-- For each directory task a scan leaves open, up to three, the worker reads the page the answers
-- cited most for its site, obeying the site's robots.txt, and compares it with the location's
-- details. What it found is kept here, a JSON array with one entry for each page: the site, the
-- address read, why it was not read if it was not, and whether it names the business and shows
-- its phone and address. Never the page itself. The worker writes it with the secret key just
-- before it completes the scan, as it writes `site_check`. Null when the scan did not look.
--
-- Additive: the Worker deployed before this migration neither reads nor writes it.
alter table public.scans
  add column cited_pages jsonb;

-- A member queues a scan but must not attach a check to it. The policy is otherwise unchanged.
drop policy "Members queue manual scans" on public.scans;
create policy "Members queue manual scans"
  on public.scans for insert to authenticated
  with check (
    public.can_access_location(location_id)
    and trigger = 'manual'
    and status = 'queued'
    and requested_by = (select auth.uid())
    and visibility_score is null
    and error is null
    and started_at is null
    and finished_at is null
    and sample_data = false
    and site_check is null
    and cited_pages is null
  );
