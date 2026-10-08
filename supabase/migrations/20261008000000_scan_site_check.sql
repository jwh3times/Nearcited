-- The on-page check of a location's own website, kept with the scan that made it.
--
-- Until now a scan turned the check into recommendations and threw the rest away, so the product
-- could say what failed but not show the whole checklist, nor build an action plan that explains
-- why a business's own site is not being cited. The worker writes this with the secret key just
-- before it completes the scan. Null when the page was not checked.
alter table public.scans
  add column site_check jsonb;

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
  );
