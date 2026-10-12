-- Telling an organization's owners what was done, and holding back while they have not been
-- told (issue #135, docs/adr/0014-only-the-worker-carries-out-an-action.md).
--
-- The owners are told of every action within 48 hours. One message a day gathers what was
-- carried out and what is newly waiting. If an action passes 36 hours without its notice,
-- nothing more is carried out for that organization until its owners have been told, which
-- leaves twelve hours to do it by hand.
--
-- The Worker deployed before this migration goes on working: it names the columns it reads, and
-- `claim_action()` keeps its name, its argument and what it returns.

alter table public.actions
  -- When the organization's owners were told it had been carried out.
  add column told_at timestamptz,
  -- When the daily message said it was waiting for a yes.
  add column waiting_told_at timestamptz;

-- Whether nothing more may be carried out for an organization: one of its actions was carried
-- out more than 36 hours ago and its owners have still not been told. Never a test
-- organization, whose record on the page is the notice. For the worker and the functions below.
create function public.organization_held(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations o
    join public.locations l on l.organization_id = o.id
    join public.actions a on a.location_id = l.id
    where o.id = org
      and not o.is_test
      and a.status = 'done'
      and a.told_at is null
      and a.done_at < now() - interval '36 hours'
  );
$$;

revoke execute on function public.organization_held(uuid) from public, anon, authenticated;
grant execute on function public.organization_held(uuid) to service_role;

-- The same, asked about a location by someone reading it: so the page can say why an approved
-- action is waiting. False for anyone who can read neither the location nor everything.
create function public.location_held(location uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (public.can_access_location(location) or (select public.is_operator()))
    and public.organization_held((select l.organization_id from public.locations l where l.id = location));
$$;

revoke execute on function public.location_held(uuid) from public, anon;
grant execute on function public.location_held(uuid) to authenticated;

-- The worker takes an approved action to carry out, as before, and now not while the action's
-- organization is held: then it may not go ahead, and the answer is zero.
create or replace function public.claim_action(action uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  try integer;
begin
  update public.actions a
  set carrying_since = now(), attempts = a.attempts + 1
  where a.id = action
    and a.status = 'approved'
    and (a.carrying_since is null or a.carrying_since < now() - interval '10 minutes')
    and not public.organization_held(
      (select l.organization_id from public.locations l where l.id = a.location_id))
  returning a.attempts into try;
  return coalesce(try, 0);
end;
$$;
