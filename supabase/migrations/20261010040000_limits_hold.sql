-- Three ways around a plan's limits, closed (issue #9).
--
-- A plan's limits are an organization's, and nothing limited organizations: one account could
-- make any number, each on the free plan with its own free first scan, could delete one and
-- start again, and could move a location or a prompt to where the limit had already been
-- reached, because the limits are checked when a row is added and not when it is moved.

-- One organization for each account. Switching between several is not built, and until it is, a
-- second one is only a way to a second free plan. The operator and a test account are let
-- through: the operator to look after their own, a test account to exercise the product.
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

-- An organization is not deleted through the API. Nothing in the app offers it, and deleting one
-- to make another reset everything counted against it. Closing an account properly is work of
-- its own; until then it is done for the owner, with the secret key.
drop policy "Owners delete their organization" on public.organizations;
revoke delete on public.organizations from authenticated;

-- A location stays in its organization and a prompt stays on its location. Both limits are
-- checked when a row is added, so a row that could be moved could be moved past them. This is the
-- guard that already keeps an API role from the two plan flags.
create or replace function public.guard_plan_flags()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_table_name = 'locations' then
    if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
      raise exception 'A location cannot be moved to another organization.' using errcode = '42501';
    end if;
    new.paused_by_plan := case when tg_op = 'INSERT' then false else old.paused_by_plan end;
  else
    if tg_op = 'UPDATE' and new.location_id is distinct from old.location_id then
      raise exception 'A prompt cannot be moved to another location.' using errcode = '42501';
    end if;
    new.set_aside_by_plan :=
      case when tg_op = 'INSERT' then false else old.set_aside_by_plan and not new.is_active end;
  end if;
  return new;
end;
$$;
