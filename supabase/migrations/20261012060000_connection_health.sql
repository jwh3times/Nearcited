-- A connection that stops working, and one the plan stops including (issue #134).
--
-- Broken: at once when the outside service refuses the sign-in, and after three days in a row
-- of a sync failing for any other reason. One that only kept failing is still tried once a day
-- and mends itself; one that was refused waits for its owner. Its owners and admins are told
-- when it breaks and once more a week later.
--
-- Paused: when the organization's allowances stop including the kind of work the connection is
-- for. Nothing is synced and nothing is done through it. The sign-in is kept for thirty days,
-- so going back to the plan restores it without signing in again, and is then removed.
--
-- The Worker deployed before this migration goes on working: it names the columns it reads, and
-- every function it calls keeps its name and its arguments.

alter table public.connections
  -- How many days in a row a sync has failed for a reason other than a refused sign-in.
  add column failed_days integer not null default 0 check (failed_days >= 0),
  add column last_failed_on date,
  add column broken_reason text check (broken_reason in ('refused', 'failing')),
  add column broken_at timestamptz,
  -- When its owners and admins were told it broke, and when they were reminded.
  add column broken_told_at timestamptz,
  add column broken_reminded_at timestamptz,
  add column paused_at timestamptz,
  -- Why it was removed: someone asked, or its plan had not included it for thirty days.
  add column removal_reason text check (removal_reason in ('asked', 'plan'));

update public.connections set removal_reason = 'asked' where status in ('removing', 'removed');

-- Which allowance a kind of connection needs. A kind that is not here needs none, as the sample
-- kind does not. Nothing reads this but the functions below.
create table public.connection_kind_allowances (
  kind public.connection_kind primary key,
  allowance text not null references public.allowance_kinds (key)
);

comment on table public.connection_kind_allowances is
  'The allowance an organization needs for a kind of connection. A kind not listed needs none.';

alter table public.connection_kind_allowances enable row level security;
revoke all on public.connection_kind_allowances from public, anon, authenticated;
grant all on public.connection_kind_allowances to service_role;

-- Whether an organization may have a kind of connection: the kind needs no allowance, or the
-- organization has it.
create function public.allows_connection(org uuid, of_kind public.connection_kind)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (
    select 1
    from public.connection_kind_allowances k
    join public.organizations o on o.id = org
    where k.kind = of_kind and not (o.allowances ? k.allowance)
  );
$$;

revoke execute on function public.allows_connection(uuid, public.connection_kind)
  from public, anon, authenticated;

-- Pauses an organization's connections of a kind its allowances no longer include, and brings
-- back the paused ones they include again. A connection that was broken when it was paused
-- comes back broken. Called wherever an organization's allowances are set.
create function public.fit_connections_to_plan(org uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections c
  set status = 'paused', paused_at = now()
  where c.organization_id = org
    and c.status in ('working', 'broken')
    and not public.allows_connection(org, c.kind);

  update public.connections c
  set status = case when c.broken_reason is null then 'working' else 'broken' end::public.connection_status,
      paused_at = null
  where c.organization_id = org
    and c.status = 'paused'
    and public.allows_connection(org, c.kind);
end;
$$;

revoke execute on function public.fit_connections_to_plan(uuid) from public, anon, authenticated;
grant execute on function public.fit_connections_to_plan(uuid) to service_role;

-- Putting an organization on a plan now also fits its connections to the plan. Otherwise as
-- before.
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
      allowances = p.allowances,
      surfaces = case
        when p.assistants >= 2 then array['chatgpt', 'claude']::public.surface[]
        when cardinality(o.surfaces) = 1 and o.surfaces[1] in ('chatgpt', 'claude') then o.surfaces
        else array['chatgpt']::public.surface[]
      end
  where o.id = org
  returning o.* into result;

  if result.id is not null then
    perform public.fit_to_plan(org);
    perform public.fit_connections_to_plan(org);
  end if;
  return result;
end;
$$;

-- The operator's limits editor sets an organization's allowances, so it fits its connections
-- to them too. Otherwise as before.
create or replace function public.operator_set_limits(
  org uuid,
  locations integer,
  queries_per_location integer,
  manual_scans_per_month integer,
  every_days integer,
  org_allowances jsonb default null
)
returns setof public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  was public.organizations;
  becoming jsonb;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.organizations o where o.id = org for update;
  if not found then
    return;
  end if;

  becoming := coalesce(org_allowances, was.allowances);

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
        'scan_every_days', was.scan_every_days,
        'allowances', was.allowances
      ),
      'to', jsonb_build_object(
        'plan_key', null,
        'max_locations', locations,
        'max_queries_per_location', queries_per_location,
        'max_manual_scans_per_month', manual_scans_per_month,
        'scan_every_days', every_days,
        'allowances', becoming
      )
    )
  );

  update public.organizations o
  set plan_key = null,
      max_locations = locations,
      max_queries_per_location = queries_per_location,
      max_manual_scans_per_month = manual_scans_per_month,
      scan_every_days = every_days,
      allowances = becoming
  where o.id = org;

  perform public.fit_connections_to_plan(org);
  return query select * from public.organizations o where o.id = org;
end;
$$;

-- A connection is made only of a kind the organization's allowances include. Otherwise as
-- before.
create or replace function public.create_connection(
  org uuid,
  new_id uuid,
  of_kind public.connection_kind,
  account_label text,
  sealed_sign_in text
)
returns setof public.connections
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not public.has_org_role(org, array['owner', 'admin']::public.member_role[]) then
    return;
  end if;
  if sealed_sign_in is null or sealed_sign_in = '' then
    raise exception 'A connection is made with its sign-in.' using errcode = '22023';
  end if;
  if not public.allows_connection(org, of_kind) then
    raise exception 'This organization''s plan does not include connecting this kind of account.'
      using errcode = 'NC012';
  end if;

  insert into public.connections (id, organization_id, kind, label, connected_by, connected_by_email)
  values (
    new_id,
    org,
    of_kind,
    btrim(account_label),
    caller,
    (select u.email from auth.users u where u.id = caller)
  );
  insert into public.connection_secrets (connection_id, sealed) values (new_id, sealed_sign_in);

  return query select * from public.connections c where c.id = new_id;
end;
$$;

-- Asking for a removal now says why: somebody asked. Otherwise as before.
create or replace function public.request_connection_removal(connection uuid)
returns setof public.connections
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  c public.connections;
begin
  select * into c from public.connections where id = connection for update;
  if not found
    or not public.has_org_role(c.organization_id, array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;

  if c.status not in ('removing', 'removed') then
    update public.connections
    set status = 'removing',
        removal_reason = 'asked',
        removed_by = caller,
        removed_by_email = (select u.email from auth.users u where u.id = caller),
        removal_requested_at = now()
    where id = connection;
  end if;

  return query select * from public.connections x where x.id = connection;
end;
$$;

-- Starts the removal of every connection paused for thirty days: the plan has not included it
-- for that long, so its sign-in is no longer kept. Returns them, for the worker to finish as it
-- finishes any removal. Worker only: the daily run calls it.
create function public.expire_paused_connections()
returns setof uuid
language sql security definer set search_path = ''
as $$
  update public.connections
  set status = 'removing', removal_reason = 'plan', removal_requested_at = now()
  where status = 'paused' and paused_at < now() - interval '30 days'
  returning id;
$$;

revoke execute on function public.expire_paused_connections() from public, anon, authenticated;
grant execute on function public.expire_paused_connections() to service_role;

-- Keeps that a sync failed. A refused sign-in breaks the connection at once. Any other failure
-- counts one for the day, however many times it was tried, and the third day in a row breaks
-- it. Returns where the connection stands and whether this is what broke it, so its owners can
-- be told once. No row for a connection that is neither working nor broken. Worker only.
create function public.record_connection_failure(connection uuid, refused boolean)
returns table (status public.connection_status, newly_broken boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  c public.connections;
  today date := (now() at time zone 'UTC')::date;
  days integer;
  breaks boolean;
begin
  select * into c from public.connections where id = connection for update;
  if not found or c.status not in ('working', 'broken') then
    return;
  end if;

  if refused then
    breaks := c.status = 'working' or c.broken_reason = 'failing';
    update public.connections
    set status = 'broken',
        broken_reason = 'refused',
        broken_at = case when breaks then now() else broken_at end,
        broken_told_at = case when breaks then null else broken_told_at end,
        broken_reminded_at = case when breaks then null else broken_reminded_at end
    where id = connection;
    return query select 'broken'::public.connection_status, breaks;
    return;
  end if;

  days := case when c.last_failed_on = today then c.failed_days else c.failed_days + 1 end;
  breaks := c.status = 'working' and days >= 3;
  update public.connections
  set failed_days = days,
      last_failed_on = today,
      status = case when breaks then 'broken' else status end,
      broken_reason = case when breaks then 'failing' else broken_reason end,
      broken_at = case when breaks then now() else broken_at end
  where id = connection;
  return query
    select x.status, breaks from public.connections x where x.id = connection;
end;
$$;

revoke execute on function public.record_connection_failure(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.record_connection_failure(uuid, boolean) to service_role;

-- A sync that succeeds now also mends a connection that had only kept failing: it works again,
-- and its count of failed days starts over. One whose sign-in was refused is not synced at all.
-- Otherwise as before.
create or replace function public.record_connection_sync(connection uuid, reached jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if reached is null or jsonb_typeof(reached) <> 'array' or exists (
    select 1 from jsonb_array_elements(reached) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'id', '') = ''
       or jsonb_typeof(e -> 'label') is distinct from 'string'
  ) then
    raise exception 'A sync finds a list of things, each with an id and a label.'
      using errcode = '22023';
  end if;

  update public.connections
  set choices = reached,
      last_synced_at = now(),
      status = 'working',
      failed_days = 0,
      last_failed_on = null,
      broken_reason = null,
      broken_at = null,
      broken_told_at = null,
      broken_reminded_at = null
  where id = connection
    and (status = 'working' or (status = 'broken' and broken_reason = 'failing'));
  if not found then
    return false;
  end if;

  update public.connection_locations m
  set external_label = e ->> 'label'
  from jsonb_array_elements(reached) e
  where m.connection_id = connection
    and m.external_id = e ->> 'id'
    and m.external_label is distinct from e ->> 'label';
  return true;
end;
$$;

-- What is due for a sync now includes a connection that only kept failing, which is still
-- tried once a day. Otherwise as before.
create or replace function public.connections_due_for_sync(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select c.id
  from public.connections c
  where (c.status = 'working' or (c.status = 'broken' and c.broken_reason = 'failing'))
    and (c.last_synced_at is null or c.last_synced_at < now() - interval '20 hours')
  order by c.last_synced_at asc nulls first
  limit max_rows;
$$;

-- A match is refused for a connection that is not working, with the reason. Otherwise as
-- before.
create or replace function public.match_connection_location(connection uuid, location uuid, external text)
returns setof public.connection_locations
language plpgsql security definer set search_path = ''
as $$
declare
  c public.connections;
  choice jsonb;
begin
  select * into c from public.connections where id = connection for update;
  if not found
    or not public.has_org_role(c.organization_id, array['owner', 'admin']::public.member_role[])
    or not exists (
      select 1 from public.locations l
      where l.id = location and l.organization_id = c.organization_id
    )
  then
    return;
  end if;

  if c.status = 'broken' then
    raise exception 'This account is not working, so nothing about it can be changed until it is.'
      using errcode = 'NC012';
  elsif c.status = 'paused' then
    raise exception 'This organization''s plan does not include this account any more.'
      using errcode = 'NC012';
  elsif c.status <> 'working' then
    raise exception 'This account is not connected any more.' using errcode = 'NC012';
  end if;

  select e into choice from jsonb_array_elements(c.choices) e where e ->> 'id' = external limit 1;
  if choice is null then
    raise exception 'That is not something this account reaches.' using errcode = 'NC012';
  end if;

  if exists (
    select 1 from public.connection_locations m
    where m.connection_id = connection and m.external_id = external and m.location_id <> location
  ) then
    raise exception 'That already belongs to another location. Take it from that one first.'
      using errcode = 'NC012';
  end if;
  if exists (
    select 1 from public.connection_locations m
    where m.location_id = location and m.kind = c.kind and m.connection_id <> connection
  ) then
    raise exception 'This location is matched to another account of the same kind. Take it from that one first.'
      using errcode = 'NC012';
  end if;

  insert into public.connection_locations as m
    (connection_id, kind, location_id, external_id, external_label)
  values (connection, c.kind, location, external, choice ->> 'label')
  on conflict (connection_id, location_id) do update
    set external_id = excluded.external_id,
        external_label = excluded.external_label,
        matched_at = now();

  return query
    select * from public.connection_locations m
    where m.connection_id = connection and m.location_id = location;
end;
$$;
