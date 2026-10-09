-- What happens when an organization has more than its plan allows (issue #9, step 3).
--
-- Moving to a smaller plan deletes nothing. Locations beyond the plan are paused and prompts
-- beyond it are set aside; both stay readable, the owner can swap which are in use, and a larger
-- plan brings them back. This also moves the count of scans by hand somewhere a deleted location
-- cannot take it, and drops the daily column the last migration left unread.

alter table public.locations
  add column paused_by_plan boolean not null default false;
alter table public.tracked_queries
  add column set_aside_by_plan boolean not null default false;

comment on column public.locations.paused_by_plan is
  'True while the organization has more locations than its plan covers and this is one of those not scanned. Changed only by apply_plan() and activate_location().';
comment on column public.tracked_queries.set_aside_by_plan is
  'True for a prompt made inactive because the plan covers fewer. A larger plan restores it; a prompt its owner retired is left alone.';

-- Members may update these tables, so the two flags are guarded: an API role cannot pause or
-- unpause a location, and can clear a prompt's flag only by restoring the prompt, which the
-- limit trigger then checks. The functions below run as their owner and are not held back.
create function public.guard_plan_flags()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_table_name = 'locations' then
    new.paused_by_plan := case when tg_op = 'INSERT' then false else old.paused_by_plan end;
  else
    new.set_aside_by_plan :=
      case when tg_op = 'INSERT' then false else old.set_aside_by_plan and not new.is_active end;
  end if;
  return new;
end;
$$;

create trigger locations_guard_plan_flags
  before insert or update on public.locations
  for each row execute function public.guard_plan_flags();
create trigger tracked_queries_guard_plan_flags
  before insert or update on public.tracked_queries
  for each row execute function public.guard_plan_flags();

-- Brings an organization's locations and prompts inside its limits, and back out again when the
-- limits grow. Oldest first throughout, and a location already in use is kept ahead of a paused
-- one, so an owner's swap survives the next change of plan.
create function public.fit_to_plan(org uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.organizations;
begin
  select * into o from public.organizations where id = org for update;
  if not found then
    return;
  end if;

  update public.locations l
  set paused_by_plan = ranked.place > o.max_locations
  from (
    select id, row_number() over (order by paused_by_plan, created_at, id) as place
    from public.locations where organization_id = org
  ) ranked
  where l.id = ranked.id and l.paused_by_plan is distinct from (ranked.place > o.max_locations);

  -- Too many active prompts: the newest are set aside.
  update public.tracked_queries q
  set is_active = false, set_aside_by_plan = true
  from (
    select q2.id,
           row_number() over (partition by q2.location_id order by q2.created_at, q2.id) as place
    from public.tracked_queries q2
    join public.locations l on l.id = q2.location_id
    where l.organization_id = org and q2.is_active
  ) ranked
  where q.id = ranked.id and ranked.place > o.max_queries_per_location;

  -- Room again: the oldest of those set aside come back. Ones the owner retired do not.
  update public.tracked_queries q
  set is_active = true, set_aside_by_plan = false
  from (
    select q2.id,
           row_number() over (partition by q2.location_id order by q2.created_at, q2.id) as place,
           (select count(*) from public.tracked_queries a
            where a.location_id = q2.location_id and a.is_active) as active
    from public.tracked_queries q2
    join public.locations l on l.id = q2.location_id
    where l.organization_id = org and q2.set_aside_by_plan and not q2.is_active
  ) ranked
  where q.id = ranked.id and ranked.active + ranked.place <= o.max_queries_per_location;
end;
$$;

revoke execute on function public.fit_to_plan(uuid) from public, anon, authenticated;
grant execute on function public.fit_to_plan(uuid) to service_role;

-- Putting an organization on a plan now also fits it to the plan. Otherwise as before.
create or replace function public.apply_plan(org uuid, plan text, locations integer default null)
returns public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  p public.plans;
  result public.organizations;
begin
  select * into p from public.plans where key = plan;
  if not found then
    raise exception 'There is no plan called %.', plan using errcode = '22023';
  end if;

  update public.organizations o
  set plan_key = p.key,
      max_locations = greatest(p.included_locations, coalesce(locations, 0)),
      max_queries_per_location = p.max_queries_per_location,
      max_manual_scans_per_month = p.max_manual_scans_per_month,
      scan_every_days = p.scan_every_days,
      emails_report = p.emails_report,
      surfaces = case
        when p.assistants >= 2 then array['chatgpt', 'claude']::public.surface[]
        when cardinality(o.surfaces) = 1 and o.surfaces[1] in ('chatgpt', 'claude') then o.surfaces
        else array['chatgpt']::public.surface[]
      end
  where o.id = org
  returning o.* into result;

  if result.id is not null then
    perform public.fit_to_plan(org);
  end if;
  return result;
end;
$$;

-- A member brings a paused location back into use. When the plan has no room, they say which
-- location in use is paused in its place. Returns the location, or no row for a non-member.
create function public.activate_location(location uuid, instead_of uuid default null)
returns setof public.locations
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  allowed integer;
  in_use integer;
begin
  if not public.can_access_location(location) then
    return;
  end if;

  select o.id, o.max_locations into org, allowed
  from public.organizations o
  join public.locations l on l.organization_id = o.id
  where l.id = location
  for update of o;

  if exists (select 1 from public.locations l where l.id = location and not l.paused_by_plan) then
    return query select l.* from public.locations l where l.id = location;
    return;
  end if;

  select count(*) into in_use
  from public.locations l where l.organization_id = org and not l.paused_by_plan;

  if in_use >= allowed then
    if instead_of is null or not exists (
      select 1 from public.locations l
      where l.id = instead_of and l.organization_id = org and not l.paused_by_plan
    ) then
      raise exception 'This organization''s plan covers % %. Choose one to pause in this one''s place.',
        allowed, case when allowed = 1 then 'location' else 'locations' end
        using errcode = 'NC005';
    end if;
    update public.locations set paused_by_plan = true where id = instead_of;
  end if;

  return query
    update public.locations l set paused_by_plan = false where l.id = location returning l.*;
end;
$$;

revoke execute on function public.activate_location(uuid, uuid) from public, anon;
grant execute on function public.activate_location(uuid, uuid) to authenticated;

-- A paused location is not scanned on the schedule. Otherwise as before.
create or replace function public.locations_due_for_scan(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select l.id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where l.scan_frequency <> 'off'
    and not l.paused_by_plan
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

-- Scans by hand were counted from the scans table, so deleting a location and adding it again
-- forgot the month's count. The count now lives on the organization.
alter table public.organizations
  add column manual_scans_month date,
  add column manual_scans_used integer not null default 0 check (manual_scans_used >= 0);

comment on column public.organizations.manual_scans_month is
  'The calendar month (UTC, its first day) that manual_scans_used counts. Another month means none used yet.';
comment on column public.organizations.manual_scans_used is
  'Scans started by hand in manual_scans_month, not counting the organization''s first ever. Outlives the locations scanned.';

update public.organizations o
set manual_scans_month = date_trunc('month', now() at time zone 'UTC')::date,
    manual_scans_used = coalesce((
      select count(*)
      from public.scans s
      join public.locations l on l.id = s.location_id
      where l.organization_id = o.id
        and s.trigger = 'manual'
        and s.requested_by is not null
        and s.created_at > o.first_scan_at
        and s.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
    ), 0);

create or replace function public.enforce_manual_scan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  o public.organizations;
  paused boolean;
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
  used integer;
begin
  -- Only scans a member asked for. Scheduled scans, and anything the worker inserts on its own
  -- behalf, are governed by the schedule instead.
  if new.trigger <> 'manual' or new.requested_by is null then
    return null;
  end if;

  select org.* into o
  from public.organizations org
  join public.locations l on l.organization_id = org.id
  where l.id = new.location_id
  for update of org;

  select l.paused_by_plan into paused from public.locations l where l.id = new.location_id;
  if paused then
    raise exception 'This location is paused because the organization''s plan covers fewer locations. Bring it back into use to scan it.'
      using errcode = 'NC005';
  end if;

  -- The first scan an organization ever runs is let through and not counted.
  if o.first_scan_at is null then
    update public.organizations set first_scan_at = new.created_at where id = o.id;
    return null;
  end if;

  used := case when o.manual_scans_month = this_month then o.manual_scans_used else 0 end;
  if used >= o.max_manual_scans_per_month then
    if o.max_manual_scans_per_month = 0 then
      raise exception 'This organization''s plan does not include scans started by hand. Its scheduled scans run by themselves.'
        using errcode = 'NC003';
    end if;
    raise exception 'This organization can start % % by hand in a calendar month and has used them all.',
      o.max_manual_scans_per_month,
      case when o.max_manual_scans_per_month = 1 then 'scan' else 'scans' end
      using errcode = 'NC003';
  end if;

  update public.organizations
  set manual_scans_month = this_month, manual_scans_used = used + 1
  where id = o.id;
  return null;
end;
$$;

-- Left in place by the last migration so the Worker then running kept working. Nothing reads it.
alter table public.organizations drop column max_manual_scans_per_day;
