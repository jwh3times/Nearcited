-- A location's own scan frequency goes (issue #9).
--
-- How often a location is scanned has been its plan's to say since
-- 20261011010000_scan_frequency_follows_plan.sql set every location to `daily` and the app
-- stopped offering the choice. The Worker no longer reads or writes the column, so it and the
-- type behind it are dropped, and the schedule stops asking about it.
--
-- Apply this after the Worker that no longer selects the column is deployed: the one before
-- it reads the column on every location.

create or replace function public.locations_due_for_scan(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select l.id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where not l.paused_by_plan
    and exists (
      select 1 from public.tracked_queries q where q.location_id = l.id and q.is_active
    )
    and not exists (
      select 1 from public.scans s
      where s.location_id = l.id
        and s.status in ('queued', 'running')
        and s.created_at > now() - interval '6 hours'
    )
    and (
      l.last_scanned_at is null
      or l.last_scanned_at < now() - make_interval(days => o.scan_every_days) + interval '4 hours'
    )
  order by l.last_scanned_at asc nulls first
  limit max_rows;
$$;

alter table public.locations drop column scan_frequency;
drop type public.scan_frequency;
