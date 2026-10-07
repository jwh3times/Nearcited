-- Plan settings on the organization: how often it is scanned and which surfaces (issue #43).
--
-- Plans differ by cadence and by which assistants are checked, not only by the counts in the
-- usage caps. Both live beside those caps and are protected the same way: a member can update
-- the organization's name and nothing else, so neither can be changed without the secret key.

alter table public.organizations
  add column scan_every_days integer not null default 2
    check (scan_every_days between 1 and 30),
  add column surfaces public.surface[];

comment on column public.organizations.scan_every_days is
  'How many days apart this organization''s locations are scanned. 1 is daily.';
comment on column public.organizations.surfaces is
  'The surfaces this organization''s scans check. Null means every surface that is set up.';

-- A location is due when its organization's cadence says so. A location can still be paused
-- (off), or ask to be scanned less often than its plan allows (weekly), but never more often.
-- The four hours of slack keep a scan that finished a little late yesterday from pushing today's
-- run to tomorrow, since the schedule fires once a day.
create or replace function public.locations_due_for_scan(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select l.id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where l.scan_frequency <> 'off'
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
      or l.last_scanned_at < now()
        - make_interval(days => greatest(
            o.scan_every_days,
            case l.scan_frequency when 'weekly' then 7 else 1 end
          ))
        + interval '4 hours'
    )
  order by l.last_scanned_at asc nulls first
  limit max_rows;
$$;
