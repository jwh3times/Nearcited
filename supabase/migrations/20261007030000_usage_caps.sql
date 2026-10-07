-- Usage caps per organization (issue #7).
--
-- Every location, every prompt and every scan costs money once scans are real. The limits live
-- on the organization and are enforced by triggers, because the API talks to Postgres as the
-- signed-in user: a limit checked only in a route handler could be skipped by calling the
-- database directly.

alter table public.organizations
  add column max_locations integer not null default 1
    check (max_locations >= 0),
  add column max_queries_per_location integer not null default 10
    check (max_queries_per_location >= 0),
  add column max_manual_scans_per_day integer not null default 5
    check (max_manual_scans_per_day >= 0);

comment on column public.organizations.max_locations is
  'How many locations the organization may have.';
comment on column public.organizations.max_queries_per_location is
  'How many active prompts and keywords each location may have. Retired ones do not count.';
comment on column public.organizations.max_manual_scans_per_day is
  'How many scans members may start by hand, across the organization, in any 24 hours.';

-- A member may rename the organization and nothing else. Before this, the table-wide update
-- grant would have let an owner raise their own limits.
revoke update on public.organizations from authenticated;
grant update (name) on public.organizations to authenticated;

-- The triggers run as the function owner so they can count rows whatever the caller can see,
-- and they lock the organization row so two inserts arriving together are counted one at a time.
-- Each raises its own error code, which the API turns into a 409 with the message as written.
--
-- They fire AFTER the row is written and count it with the rest. By then row-level security has
-- already had its say, so a non-member is refused as a non-member and never learns whether a
-- limit was reached. Raising the error undoes the write.

create function public.enforce_location_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  allowed integer;
  used integer;
begin
  select o.max_locations into allowed
  from public.organizations o where o.id = new.organization_id for update;

  select count(*) into used
  from public.locations l where l.organization_id = new.organization_id;

  if used > allowed then
    raise exception 'This organization can have % % and already has that many.',
      allowed, case when allowed = 1 then 'location' else 'locations' end
      using errcode = 'NC001';
  end if;
  return null;
end;
$$;

create trigger locations_enforce_limit
  after insert on public.locations
  for each row execute function public.enforce_location_limit();

create function public.enforce_query_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  allowed integer;
  used integer;
begin
  -- Retired prompts are free. Only adding an active one, or restoring one, is counted.
  if not new.is_active then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.is_active then
    return null;
  end if;

  select o.max_queries_per_location into allowed
  from public.organizations o
  join public.locations l on l.organization_id = o.id
  where l.id = new.location_id
  for update of o;

  select count(*) into used
  from public.tracked_queries q
  where q.location_id = new.location_id and q.is_active;

  if used > allowed then
    raise exception 'A location can have % active % and this one already has that many.',
      allowed, case when allowed = 1 then 'prompt' else 'prompts' end
      using errcode = 'NC002';
  end if;
  return null;
end;
$$;

create trigger tracked_queries_enforce_limit
  after insert or update of is_active on public.tracked_queries
  for each row execute function public.enforce_query_limit();

create function public.enforce_manual_scan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  allowed integer;
  used integer;
begin
  -- Only scans a member asked for. Scheduled scans, and anything the worker inserts on its own
  -- behalf, are governed by the schedule instead.
  if new.trigger <> 'manual' or new.requested_by is null then
    return null;
  end if;

  select o.id, o.max_manual_scans_per_day into org, allowed
  from public.organizations o
  join public.locations l on l.organization_id = o.id
  where l.id = new.location_id
  for update of o;

  select count(*) into used
  from public.scans s
  join public.locations l on l.id = s.location_id
  where l.organization_id = org
    and s.trigger = 'manual'
    and s.requested_by is not null
    and s.created_at > now() - interval '24 hours';

  if used > allowed then
    raise exception 'This organization can start % manual % in 24 hours and has used them all.',
      allowed, case when allowed = 1 then 'scan' else 'scans' end
      using errcode = 'NC003';
  end if;
  return null;
end;
$$;

create trigger scans_enforce_manual_limit
  after insert on public.scans
  for each row execute function public.enforce_manual_scan_limit();

-- Trigger functions are called by the triggers, never directly.
revoke execute on function
  public.enforce_location_limit(),
  public.enforce_query_limit(),
  public.enforce_manual_scan_limit()
from public, anon, authenticated;
