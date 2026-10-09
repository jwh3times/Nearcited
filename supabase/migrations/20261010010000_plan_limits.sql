-- An organization's limits come from its plan (docs/adr/0006-plans-are-rows.md, issue #9).
--
-- Step 2 of billing. A new organization starts on the free plan, scans by hand are counted over
-- a calendar month, an organization's first scan is not counted at all, and whether a report is
-- emailed is a plan setting. Still nothing charges anyone.

-- Scans by hand were capped per 24 hours. Plans cap them per calendar month, so the column
-- changes its meaning and its name. What an organization had per day becomes that times thirty.
alter table public.organizations
  add column max_manual_scans_per_month integer not null default 0
    check (max_manual_scans_per_month >= 0),
  add column emails_report boolean not null default true,
  add column first_scan_at timestamptz;

comment on column public.organizations.max_manual_scans_per_month is
  'How many scans members may start by hand, across the organization, in a calendar month (UTC). The first scan it ever runs is not counted.';
comment on column public.organizations.emails_report is
  'Whether owners are emailed a report after each scan.';
comment on column public.organizations.first_scan_at is
  'When a member started this organization''s first scan, which is free of the monthly limit. Null until then.';

update public.organizations
set max_manual_scans_per_month = least(max_manual_scans_per_day * 30, 100000);

update public.organizations o
set first_scan_at = first.at
from (
  select l.organization_id, min(s.created_at) as at
  from public.scans s
  join public.locations l on l.id = s.location_id
  group by l.organization_id
) first
where first.organization_id = o.id;

-- The old column stays for now, unread: the Worker that is running while this migration is
-- applied still selects it, and dropping it would fail every request until the next deploy. A
-- later migration drops it.
comment on column public.organizations.max_manual_scans_per_day is
  'No longer read. Replaced by max_manual_scans_per_month; to be dropped.';

-- Counts this calendar month's scans by hand, in UTC. An organization's first scan ever is let
-- through whatever its plan allows and is not counted: it is how a new account sees the product
-- work, and the free plan allows no others.
create or replace function public.enforce_manual_scan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  allowed integer;
  first_at timestamptz;
  used integer;
begin
  -- Only scans a member asked for. Scheduled scans, and anything the worker inserts on its own
  -- behalf, are governed by the schedule instead.
  if new.trigger <> 'manual' or new.requested_by is null then
    return null;
  end if;

  select o.id, o.max_manual_scans_per_month, o.first_scan_at into org, allowed, first_at
  from public.organizations o
  join public.locations l on l.organization_id = o.id
  where l.id = new.location_id
  for update of o;

  if first_at is null then
    update public.organizations set first_scan_at = new.created_at where id = org;
    return null;
  end if;

  select count(*) into used
  from public.scans s
  join public.locations l on l.id = s.location_id
  where l.organization_id = org
    and s.trigger = 'manual'
    and s.requested_by is not null
    and s.created_at > first_at
    and s.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';

  if used > allowed then
    if allowed = 0 then
      raise exception 'This organization''s plan does not include scans started by hand. Its scheduled scans run by themselves.'
        using errcode = 'NC003';
    end if;
    raise exception 'This organization can start % % by hand in a calendar month and has used them all.',
      allowed, case when allowed = 1 then 'scan' else 'scans' end
      using errcode = 'NC003';
  end if;
  return null;
end;
$$;

-- Puts an organization on a plan and copies the plan's values onto it, which is what the
-- triggers and the schedule read. `locations` is how many it has paid for when that is more than
-- the plan includes. Not for the API roles: the worker calls it when a subscription changes, and
-- the functions below call it for a new organization.
--
-- A plan with one assistant keeps the one the organization already had when it had exactly one,
-- so a choice survives a change of plan. Otherwise it starts on ChatGPT.
create function public.apply_plan(org uuid, plan text, locations integer default null)
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
  return result;
end;
$$;

revoke execute on function public.apply_plan(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.apply_plan(uuid, text, integer) to service_role;

-- A new organization starts on the free plan. A test account's is still set by hand, generous
-- enough to exercise every screen, and on no plan.
create or replace function public.create_organization(org_name text)
returns public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  for_test boolean;
  org public.organizations;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  for_test := exists (
    select 1 from public.platform_roles r where r.user_id = caller and r.role = 'test'
  );

  insert into public.organizations (name, created_by, is_test)
  values (btrim(org_name), caller, for_test)
  returning * into org;

  if for_test then
    update public.organizations
    set max_locations = 25,
        max_queries_per_location = 25,
        max_manual_scans_per_month = 500,
        scan_every_days = 1
    where id = org.id
    returning * into org;
  else
    org := public.apply_plan(org.id, 'free');
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (org.id, caller, 'owner');

  return org;
end;
$$;

-- The operator's limits editor, now counting scans by hand per month. A parameter cannot be
-- renamed in place, so the function is made again.
drop function public.operator_set_limits(uuid, integer, integer, integer, integer);

create function public.operator_set_limits(
  org uuid,
  locations integer,
  queries_per_location integer,
  manual_scans_per_month integer,
  every_days integer
)
returns setof public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  was public.organizations;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.organizations o where o.id = org for update;
  if not found then
    return;
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    org,
    'set_limits',
    jsonb_build_object(
      'from', jsonb_build_object(
        'plan_key', was.plan_key,
        'max_locations', was.max_locations,
        'max_queries_per_location', was.max_queries_per_location,
        'max_manual_scans_per_month', was.max_manual_scans_per_month,
        'scan_every_days', was.scan_every_days
      ),
      'to', jsonb_build_object(
        'plan_key', null,
        'max_locations', locations,
        'max_queries_per_location', queries_per_location,
        'max_manual_scans_per_month', manual_scans_per_month,
        'scan_every_days', every_days
      )
    )
  );

  return query
    update public.organizations o
    set plan_key = null,
        max_locations = locations,
        max_queries_per_location = queries_per_location,
        max_manual_scans_per_month = manual_scans_per_month,
        scan_every_days = every_days
    where o.id = org
    returning o.*;
end;
$$;

revoke execute on function public.operator_set_limits(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.operator_set_limits(uuid, integer, integer, integer, integer)
  to authenticated;
