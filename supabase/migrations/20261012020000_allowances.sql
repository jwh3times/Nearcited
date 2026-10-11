-- Allowances: the kinds of work a plan includes (issue #133,
-- docs/adr/0012-a-plans-allowances-are-one-set.md).
--
-- A plan's limits are columns, and each is handled by name in every function that copies, edits
-- or lowers a plan. The product is about to do a dozen kinds of work for an owner
-- (docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md), each of which a plan
-- includes or does not, some up to a number a month. A column for each would remake those
-- functions every time, so they are one set on the plan:
--
--   {"drafts": 12, "google_profile": true}
--
-- A kind that is absent is not included. true is included. A whole number is how many a month
-- the plan allows for each location it covers. Nothing counts use yet, and no kind exists yet:
-- the first arrives with the work that needs it.
--
-- The Worker deployed before this migration goes on working. It names the columns it reads, and
-- it calls the three functions remade here by argument name, where the new argument has a
-- default that leaves allowances as they are.

-- The kinds that exist. A set may name no other, so a slip of the keyboard cannot become an
-- allowance. Part of the price list: anyone reads it, and nobody writes it through the API.
create table public.allowance_kinds (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- True when a plan gives a number a month. False when the kind is included or it is not.
  counted boolean not null,
  created_at timestamptz not null default now()
);

comment on table public.allowance_kinds is
  'The kinds of work a plan can include. A plan''s allowances may name only these.';

alter table public.allowance_kinds enable row level security;
revoke all on public.allowance_kinds from public, anon, authenticated;
grant select on public.allowance_kinds to anon, authenticated;
grant all on public.allowance_kinds to service_role;

create policy "Anyone reads the kinds of allowance"
  on public.allowance_kinds for select to anon, authenticated
  using (true);

alter table public.plans
  add column allowances jsonb not null default '{}'::jsonb;

comment on column public.plans.allowances is
  'The kinds of work the plan includes: true, or how many a month for each location.';

-- An organization's own copy, as its limits are. No API role may write it: update on this table
-- is granted for the name alone.
alter table public.organizations
  add column allowances jsonb not null default '{}'::jsonb;

comment on column public.organizations.allowances is
  'The kinds of work the organization may have done, copied from its plan or set by the operator.';

-- Refuses a set that names a kind that does not exist, or gives one a value it does not take:
-- a whole number from 1 to 1,000,000 for a counted kind, true for any other.
create function public.check_allowances(a jsonb)
returns void
language plpgsql stable set search_path = ''
as $$
declare
  bad text;
begin
  if a is null or jsonb_typeof(a) <> 'object' then
    raise exception 'Allowances are a set of kinds, each with true or a number.'
      using errcode = 'NC011';
  end if;

  select e.key into bad
  from jsonb_each(a) e
  left join public.allowance_kinds k on k.key = e.key
  where k.key is null
     or (k.counted and not (
       case
         when jsonb_typeof(e.value) = 'number' and (e.value #>> '{}') ~ '^[0-9]{1,7}$'
           then (e.value #>> '{}')::integer between 1 and 1000000
         else false
       end))
     or (not k.counted and e.value <> 'true'::jsonb)
  limit 1;

  if bad is not null then
    raise exception 'There is no allowance called "%", or that is not a value it takes.', bad
      using errcode = 'NC011';
  end if;
end;
$$;

revoke execute on function public.check_allowances(jsonb) from public, anon, authenticated;

-- Runs as its owner, so the check is made whoever writes the row.
create function public.guard_allowances()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.check_allowances(new.allowances);
  return new;
end;
$$;

revoke execute on function public.guard_allowances() from public, anon, authenticated;

create trigger plans_allowances
  before insert or update of allowances on public.plans
  for each row execute function public.guard_allowances();

create trigger organizations_allowances
  before insert or update of allowances on public.organizations
  for each row execute function public.guard_allowances();

-- A test organization may have every kind of work done, with room to exercise it, as its limits
-- are generous. A kind added later reaches the test organizations that already exist.
create function public.test_allowances()
returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(k.key, case when k.counted then to_jsonb(1000) else 'true'::jsonb end),
    '{}'::jsonb)
  from public.allowance_kinds k;
$$;

revoke execute on function public.test_allowances() from public, anon, authenticated;

create function public.give_test_organizations_a_new_kind()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.organizations o
  set allowances = o.allowances
    || jsonb_build_object(new.key, case when new.counted then to_jsonb(1000) else 'true'::jsonb end)
  where o.is_test;
  return new;
end;
$$;

revoke execute on function public.give_test_organizations_a_new_kind()
  from public, anon, authenticated;

create trigger allowance_kinds_reach_test_organizations
  after insert on public.allowance_kinds
  for each row execute function public.give_test_organizations_a_new_kind();

-- The allowances `becomes` would lower, each with what it was and what it would be: a kind taken
-- away, which is written as false, or a smaller number. A kind added or raised is not here.
create function public.allowance_reductions(was jsonb, becomes jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      e.key,
      jsonb_build_object('from', e.value, 'to', coalesce(becomes -> e.key, 'false'::jsonb))),
    '{}'::jsonb)
  from jsonb_each(was) e
  where not (becomes ? e.key)
     or (
       jsonb_typeof(e.value) = 'number'
       and jsonb_typeof(becomes -> e.key) = 'number'
       and (becomes ->> e.key)::numeric < (e.value #>> '{}')::numeric
     );
$$;

revoke execute on function public.allowance_reductions(jsonb, jsonb)
  from public, anon, authenticated;

-- Putting an organization on a plan now copies the plan's allowances too. Otherwise as before.
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
  end if;
  return result;
end;
$$;

-- A test organization starts with every allowance. Otherwise as before.
create or replace function public.create_organization(org_name text)
returns public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_role public.platform_role;
  org public.organizations;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select r.role into caller_role from public.platform_roles r where r.user_id = caller;

  if caller_role is null and exists (
    select 1 from public.memberships m where m.user_id = caller
  ) then
    raise exception 'This account already has an organization.' using errcode = 'NC006';
  end if;

  insert into public.organizations (name, created_by, is_test)
  values (btrim(org_name), caller, caller_role is not distinct from 'test')
  returning * into org;

  if org.is_test then
    update public.organizations
    set max_locations = 25,
        max_queries_per_location = 25,
        max_manual_scans_per_month = 500,
        scan_every_days = 1,
        allowances = public.test_allowances()
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

-- What would go down on a plan, now with its allowances. A null set leaves them as they are, so
-- none of them goes down. Otherwise as before.
drop function public.plan_reductions(public.plans, integer, integer, integer, integer, boolean);

create function public.plan_reductions(
  p public.plans,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean,
  plan_allowances jsonb
)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_object_agg(lowered.field, lowered.detail), '{}'::jsonb)
  from (
    select change.field, jsonb_build_object('from', change.was, 'to', change.becomes) as detail
    from (values
      ('max_queries_per_location', to_jsonb(p.max_queries_per_location), to_jsonb(queries_per_location),
        queries_per_location < p.max_queries_per_location),
      ('assistants', to_jsonb(p.assistants), to_jsonb(plan_assistants),
        plan_assistants < p.assistants),
      ('scan_every_days', to_jsonb(p.scan_every_days), to_jsonb(every_days),
        every_days > p.scan_every_days),
      ('max_manual_scans_per_month', to_jsonb(p.max_manual_scans_per_month), to_jsonb(manual_scans_per_month),
        manual_scans_per_month < p.max_manual_scans_per_month),
      ('emails_report', to_jsonb(p.emails_report), to_jsonb(report),
        p.emails_report and not report)
    ) as change (field, was, becomes, goes_down)
    where change.goes_down
    union all
    select 'allowances', public.allowance_reductions(p.allowances, plan_allowances)
    where plan_allowances is not null
      and public.allowance_reductions(p.allowances, plan_allowances) <> '{}'::jsonb
  ) lowered;
$$;

revoke execute on function
  public.plan_reductions(public.plans, integer, integer, integer, integer, boolean, jsonb)
  from public, anon, authenticated;

-- Changing what a plan allows, now with its allowances: an allowance taken away or made smaller
-- is a reduction like any other, refused on the spot where somebody pays and held while an
-- announcement is going to lower it. Otherwise as before. A parameter cannot be added in place,
-- so the function is made again.
drop function public.operator_set_plan(text, text, boolean, integer, integer, integer, integer, boolean);

create function public.operator_set_plan(
  plan text,
  new_name text,
  sale boolean,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean,
  plan_allowances jsonb default null
)
returns setof public.plans
language plpgsql security definer set search_path = ''
as $$
declare
  was public.plans;
  becoming jsonb;
  reductions jsonb;
  held jsonb;
  o record;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.plans p where p.key = plan for update;
  if not found then
    return;
  end if;

  -- Every new organization is put on the free plan, so it cannot be one that is not offered.
  if plan = 'free' and not sale then
    raise exception 'The free plan stays on sale: every new organization starts on it.'
      using errcode = 'NC007';
  end if;

  becoming := coalesce(plan_allowances, was.allowances);
  perform public.check_allowances(becoming);

  reductions := public.plan_reductions(
    was, queries_per_location, plan_assistants, every_days, manual_scans_per_month, report,
    becoming);

  if reductions <> '{}'::jsonb and plan <> 'free' and public.plan_has_subscribers(plan) then
    raise exception 'Subscribers pay for this plan, so what it allows can only be lowered with 30 days'' notice. Announce the reduction for a day.'
      using errcode = 'NC010';
  end if;

  select c.lowered into held
  from public.limit_changes c
  where c.plan_key = plan and c.called_off_at is null and c.completed_at is null;
  if held is not null and (
    (held ? 'max_queries_per_location' and queries_per_location <> was.max_queries_per_location)
    or (held ? 'assistants' and plan_assistants <> was.assistants)
    or (held ? 'scan_every_days' and every_days <> was.scan_every_days)
    or (held ? 'max_manual_scans_per_month' and manual_scans_per_month <> was.max_manual_scans_per_month)
    or (held ? 'emails_report' and report <> was.emails_report)
    or (held ? 'allowances' and exists (
      select 1
      from jsonb_object_keys(held -> 'allowances') as going_down (kind)
      where (becoming -> going_down.kind) is distinct from (was.allowances -> going_down.kind)
    ))
  ) then
    raise exception 'A reduction has been announced for this plan. What it lowers stays as it is until the day, or until it is called off.'
      using errcode = 'NC010';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'set_plan',
    jsonb_build_object(
      'plan', plan,
      'from', jsonb_build_object(
        'name', was.name,
        'on_sale', was.on_sale,
        'max_queries_per_location', was.max_queries_per_location,
        'assistants', was.assistants,
        'scan_every_days', was.scan_every_days,
        'max_manual_scans_per_month', was.max_manual_scans_per_month,
        'emails_report', was.emails_report,
        'allowances', was.allowances
      ),
      'to', jsonb_build_object(
        'name', btrim(new_name),
        'on_sale', sale,
        'max_queries_per_location', queries_per_location,
        'assistants', plan_assistants,
        'scan_every_days', every_days,
        'max_manual_scans_per_month', manual_scans_per_month,
        'emails_report', report,
        'allowances', becoming
      )
    )
  );

  update public.plans p
  set name = btrim(new_name),
      on_sale = sale,
      max_queries_per_location = queries_per_location,
      assistants = plan_assistants,
      scan_every_days = every_days,
      max_manual_scans_per_month = manual_scans_per_month,
      emails_report = report,
      allowances = becoming,
      updated_at = now()
  where p.key = plan;

  -- Every organization on the plan takes the new values now, keeping the locations it has.
  for o in select id, max_locations from public.organizations where plan_key = plan loop
    perform public.apply_plan(o.id, plan, o.max_locations);
  end loop;

  -- A cut to the free plan, made just now, kept so its organizations can be told of it.
  if plan = 'free' and reductions <> '{}'::jsonb then
    insert into public.limit_changes (plan_key, lowered, effective_at, completed_at)
    values (plan, reductions, now(), now());
  end if;

  return query select * from public.plans p where p.key = plan;
end;
$$;

revoke execute on function
  public.operator_set_plan(text, text, boolean, integer, integer, integer, integer, boolean, jsonb)
  from public, anon;
grant execute on function
  public.operator_set_plan(text, text, boolean, integer, integer, integer, integer, boolean, jsonb)
  to authenticated;

-- Announcing a reduction, now with the plan's allowances. Otherwise as before.
drop function public.operator_announce_limit_change(
  text, integer, integer, integer, integer, boolean, timestamptz);

create function public.operator_announce_limit_change(
  plan text,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean,
  effective timestamptz,
  plan_allowances jsonb default null
)
returns setof public.limit_changes
language plpgsql security definer set search_path = ''
as $$
declare
  p public.plans;
  reductions jsonb;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into p from public.plans where key = plan for update;
  if not found then
    return;
  end if;

  -- What is announced is made on the day without being looked at again, so it is checked now.
  if plan_allowances is not null then
    perform public.check_allowances(plan_allowances);
  end if;

  reductions := public.plan_reductions(
    p, queries_per_location, plan_assistants, every_days, manual_scans_per_month, report,
    plan_allowances);
  if reductions = '{}'::jsonb then
    raise exception 'Nothing here is lower than what the plan allows now.' using errcode = 'NC010';
  end if;
  if effective < now() + interval '30 days' then
    raise exception 'A reduction needs at least 30 days'' notice.' using errcode = 'NC010';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'announce_limit_change',
    jsonb_build_object('plan', plan, 'lowered', reductions, 'effective_at', effective)
  );

  return query
    insert into public.limit_changes (plan_key, lowered, effective_at)
    values (plan, reductions, effective)
    returning *;
end;
$$;

revoke execute on function
  public.operator_announce_limit_change(
    text, integer, integer, integer, integer, boolean, timestamptz, jsonb)
  from public, anon;
grant execute on function
  public.operator_announce_limit_change(
    text, integer, integer, integer, integer, boolean, timestamptz, jsonb)
  to authenticated;

-- Making an announced reduction, now with its allowances: a kind taken away leaves the plan's
-- set, and a smaller number replaces the larger. Otherwise as before.
create or replace function public.apply_limit_change(change_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  c public.limit_changes;
  o record;
begin
  select * into c
  from public.limit_changes
  where id = change_id and called_off_at is null and completed_at is null
    and effective_at <= now()
  for update;
  if not found then
    return false;
  end if;

  update public.plans p
  set max_queries_per_location =
        coalesce((c.lowered #>> '{max_queries_per_location,to}')::integer, p.max_queries_per_location),
      assistants = coalesce((c.lowered #>> '{assistants,to}')::integer, p.assistants),
      scan_every_days = coalesce((c.lowered #>> '{scan_every_days,to}')::integer, p.scan_every_days),
      max_manual_scans_per_month =
        coalesce((c.lowered #>> '{max_manual_scans_per_month,to}')::integer, p.max_manual_scans_per_month),
      emails_report = coalesce((c.lowered #>> '{emails_report,to}')::boolean, p.emails_report),
      allowances = (
        select coalesce(jsonb_object_agg(kept.kind, kept.allowance), '{}'::jsonb)
        from (
          select e.key as kind,
                 coalesce(c.lowered #> array['allowances', e.key, 'to'], e.value) as allowance
          from jsonb_each(p.allowances) e
        ) kept
        where kept.allowance <> 'false'::jsonb
      ),
      updated_at = now()
  where p.key = c.plan_key;

  for o in select id, max_locations from public.organizations where plan_key = c.plan_key loop
    perform public.apply_plan(o.id, c.plan_key, o.max_locations);
  end loop;

  update public.limit_changes set completed_at = now() where id = c.id;
  return true;
end;
$$;

-- The operator's limits editor, now with the organization's allowances. A null set leaves them
-- as they are. Otherwise as before.
drop function public.operator_set_limits(uuid, integer, integer, integer, integer);

create function public.operator_set_limits(
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

  return query
    update public.organizations o
    set plan_key = null,
        max_locations = locations,
        max_queries_per_location = queries_per_location,
        max_manual_scans_per_month = manual_scans_per_month,
        scan_every_days = every_days,
        allowances = becoming
    where o.id = org
    returning o.*;
end;
$$;

revoke execute on function
  public.operator_set_limits(uuid, integer, integer, integer, integer, jsonb)
  from public, anon;
grant execute on function
  public.operator_set_limits(uuid, integer, integer, integer, integer, jsonb)
  to authenticated;
