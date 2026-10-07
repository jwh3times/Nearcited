-- One scan in flight per location, enforced by the database (issue #6).
--
-- The API checked for a scan under way with a read followed by a write, so two simultaneous
-- requests could both pass and start two scans. A partial unique index closes that: the second
-- insert fails, whoever makes it.

-- Clear what the index would trip on. An in-flight scan older than thirty minutes has been
-- abandoned, and where a location somehow has two younger ones, only the newest is kept.
update public.scans
set status = 'failed',
    error = 'The scan did not finish and was abandoned. Run it again.',
    finished_at = now()
where status in ('queued', 'running')
  and (
    coalesce(started_at, created_at) < now() - interval '30 minutes'
    or id not in (
      select distinct on (location_id) id
      from public.scans
      where status in ('queued', 'running')
      order by location_id, created_at desc
    )
  );

create unique index scans_one_in_flight_idx
  on public.scans (location_id)
  where status in ('queued', 'running');
