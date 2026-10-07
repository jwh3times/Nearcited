-- Rates over a window of recent scans (issue #4).
--
-- A cell in the results grid now reads "named in x of y", counted over a location's most recent
-- scans instead of one answer. Two things in the schema support that.

-- 1. Each scan records whether it ran on generated sample data, so a window never mixes sample
--    scans with real ones. The worker sets it when it starts the scan. Existing rows become
--    false; a deployment that ran sample scans before this migration should mark them by hand.
alter table public.scans
  add column sample_data boolean not null default false;

-- A member queues a scan but must not label it. The policy is otherwise unchanged.
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
  );

-- 2. New locations are scanned daily. A window of seven scans fills in a week on a daily
--    schedule and takes seven weeks on a weekly one. Existing locations keep their setting.
alter table public.locations
  alter column scan_frequency set default 'daily';
