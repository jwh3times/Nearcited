-- Cutting what a plan allows, with notice (issue #9).
--
-- A plan's limits reach every organization on it at once (20261011020000_operator_plans.sql).
-- For a paying subscriber a lower limit is the same thing as a higher price: the same money for
-- less. So on a plan with subscribers a reduction is no longer made on the spot. It is announced
-- for a day at least thirty days out, everyone on the plan is told, and it is made on the day.
-- Raising a limit, and anything on a plan nobody pays for, still happens at once.
--
-- A row in limit_changes is one announced reduction: the fields going down, each with what it was
-- and what it becomes. The free plan's row is written as already made, because a cut to it is
-- made at once and its organizations are told the same day.
--
-- limit_change_notices is who was told and when. Only the worker writes it, as each email goes.

create table public.limit_changes (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.plans (key),
  -- What goes down: {"max_queries_per_location": {"from": 10, "to": 5}, ...}. Only these keys:
  -- max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month,
  -- emails_report.
  lowered jsonb not null check (jsonb_typeof(lowered) = 'object' and lowered <> '{}'::jsonb),
  -- The day it is made.
  effective_at timestamptz not null,
  announced_at timestamptz not null default now(),
  reminded_at timestamptz,
  called_off_at timestamptz,
  -- When it was made.
  completed_at timestamptz
);

comment on table public.limit_changes is
  'A reduction in what a plan allows, announced for a day. One open at a time for a plan.';

create unique index limit_changes_one_open
  on public.limit_changes (plan_key)
  where called_off_at is null and completed_at is null;

create table public.limit_change_notices (
  limit_change_id uuid not null references public.limit_changes (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  announced_at timestamptz,
  reminded_at timestamptz,
  called_off_at timestamptz,
  primary key (limit_change_id, organization_id)
);

comment on table public.limit_change_notices is
  'Which organizations were told of a reduction, and when. Written only by the worker.';

-- Read like price changes: an announcement by anyone signed in, who was told by the operator.
-- No API role writes either.
alter table public.limit_changes enable row level security;
revoke all on public.limit_changes from public, anon, authenticated;
grant select on public.limit_changes to authenticated;
grant all on public.limit_changes to service_role;

create policy "Anyone signed in reads announced reductions"
  on public.limit_changes for select to authenticated
  using (true);

alter table public.limit_change_notices enable row level security;
revoke all on public.limit_change_notices from public, anon, authenticated;
grant select on public.limit_change_notices to authenticated;
grant all on public.limit_change_notices to service_role;

create policy "The operator reads who was told of a reduction"
  on public.limit_change_notices for select to authenticated
  using ((select public.is_operator()));

-- Whether anyone pays for a plan: an organization on it, not a test one, with a subscription.
create function public.plan_has_subscribers(plan text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations o
    join public.subscriptions s on s.organization_id = o.id
    where o.plan_key = plan and not o.is_test and s.stripe_subscription_id is not null
  );
$$;

revoke execute on function public.plan_has_subscribers(text) from public, anon, authenticated;

-- The fields of a plan that would go down, each with what it is and what it would become. More
-- days between scans is a reduction; so is a report that stops.
create function public.plan_reductions(
  p public.plans,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean
)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_object_agg(field, jsonb_build_object('from', was, 'to', becomes)), '{}'::jsonb)
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
  where goes_down;
$$;

revoke execute on function
  public.plan_reductions(public.plans, integer, integer, integer, integer, boolean)
  from public, anon, authenticated;

-- Changing what a plan allows, as before, with two differences. On a plan somebody pays for, a
-- value that would go down is refused: it has to be announced. And a field that an open
-- announcement is going to lower is held where it is until the day. A cut to the free plan is
-- still made here and now, and is written to limit_changes as made so that its organizations
-- can be told.
create or replace function public.operator_set_plan(
  plan text,
  new_name text,
  sale boolean,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean
)
returns setof public.plans
language plpgsql security definer set search_path = ''
as $$
declare
  was public.plans;
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

  reductions := public.plan_reductions(
    was, queries_per_location, plan_assistants, every_days, manual_scans_per_month, report);

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
        'emails_report', was.emails_report
      ),
      'to', jsonb_build_object(
        'name', btrim(new_name),
        'on_sale', sale,
        'max_queries_per_location', queries_per_location,
        'assistants', plan_assistants,
        'scan_every_days', every_days,
        'max_manual_scans_per_month', manual_scans_per_month,
        'emails_report', report
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

-- Announces that what a plan allows goes down on `effective`, at least thirty days out. Only the
-- values that are lower than the plan's present ones are kept; the others are ignored, and with
-- none lower there is nothing to announce. It answers only the operator and records that it did.
--
-- Returns the announcement, or no row for anyone who is not the operator and for a plan that
-- does not exist.
create function public.operator_announce_limit_change(
  plan text,
  queries_per_location integer,
  plan_assistants integer,
  every_days integer,
  manual_scans_per_month integer,
  report boolean,
  effective timestamptz
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

  reductions := public.plan_reductions(
    p, queries_per_location, plan_assistants, every_days, manual_scans_per_month, report);
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
  public.operator_announce_limit_change(text, integer, integer, integer, integer, boolean, timestamptz)
  from public, anon;
grant execute on function
  public.operator_announce_limit_change(text, integer, integer, integer, integer, boolean, timestamptz)
  to authenticated;

-- Calls off a plan's announced reduction before its day. Returns it, or no row when there is
-- none still to call off, and for anyone who is not the operator.
create function public.operator_call_off_limit_change(plan text)
returns setof public.limit_changes
language plpgsql security definer set search_path = ''
as $$
declare
  change public.limit_changes;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into change
  from public.limit_changes c
  where c.plan_key = plan and c.called_off_at is null and c.completed_at is null
    and c.effective_at > now()
  for update;
  if not found then
    return;
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'call_off_limit_change',
    jsonb_build_object('plan', plan, 'limit_change_id', change.id, 'lowered', change.lowered)
  );

  return query
    update public.limit_changes c set called_off_at = now() where c.id = change.id returning c.*;
end;
$$;

revoke execute on function public.operator_call_off_limit_change(text) from public, anon;
grant execute on function public.operator_call_off_limit_change(text) to authenticated;

-- Makes an announced reduction, once its day has come: the plan takes the lower values and so,
-- in the same transaction, does every organization on it. Worker only: the daily run calls it.
-- Returns true when it made the change, false when there was nothing to make yet.
create function public.apply_limit_change(change_id uuid)
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
      updated_at = now()
  where p.key = c.plan_key;

  for o in select id, max_locations from public.organizations where plan_key = c.plan_key loop
    perform public.apply_plan(o.id, c.plan_key, o.max_locations);
  end loop;

  update public.limit_changes set completed_at = now() where id = c.id;
  return true;
end;
$$;

revoke execute on function public.apply_limit_change(uuid) from public, anon, authenticated;
grant execute on function public.apply_limit_change(uuid) to service_role;
