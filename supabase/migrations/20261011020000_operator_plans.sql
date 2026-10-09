-- The operator changes what a plan allows (issue #9, step 6).
--
-- A plan is a row so that it can change without a deploy (docs/adr/0006-plans-are-rows.md), and
-- nothing could change one yet. Like the operator's other changes it is one function: it answers
-- only the operator, changes only what it names, and records what it replaced in
-- operator_actions (docs/adr/0005-the-operator-changes-limits-through-one-function.md).
--
-- A change to a plan's limits reaches every organization on it at once, in the same transaction:
-- the plan is where the numbers come from, and the organization's row is what is enforced. Each
-- organization keeps the locations it pays for. An organization whose limits were set by hand is
-- on no plan and is left alone.
--
-- Prices, and how many locations a plan includes, are not changed here. A price is charged
-- through the payment provider and a subscriber's extra locations are counted from the number
-- included, so each needs more than a row updated.
--
-- Returns the plan, or no row for anyone who is not the operator and for a plan that does not
-- exist.

create function public.operator_set_plan(
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

  return query select * from public.plans p where p.key = plan;
end;
$$;

revoke execute on function
  public.operator_set_plan(text, text, boolean, integer, integer, integer, integer, boolean)
  from public, anon;
grant execute on function
  public.operator_set_plan(text, text, boolean, integer, integer, integer, integer, boolean)
  to authenticated;
