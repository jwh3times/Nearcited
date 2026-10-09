-- The operator changes an organization's limits (docs/adr/0005-the-operator-changes-limits-through-one-function.md).
--
-- Until now a plan could be changed only with the secret key. The operator's policies stay
-- read-only: this is one function that changes four columns and nothing else, answers the
-- operator and nobody else, and writes down what it changed.

create table public.operator_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Both outlive what they point at: the record of a change is kept when an account or an
  -- organization is deleted.
  actor_id uuid references auth.users (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  action text not null check (char_length(action) between 1 and 60),
  detail jsonb not null default '{}'
);

comment on table public.operator_actions is
  'What the operator changed, written by the functions that make the change. Read by the operator.';

create index operator_actions_organization
  on public.operator_actions (organization_id, created_at);

-- Nobody writes it through the API, the operator included: a row exists only because a change
-- was made. The operator reads it; a member may ask and is told nothing.
alter table public.operator_actions enable row level security;
revoke all on public.operator_actions from public, anon, authenticated;
grant select on public.operator_actions to authenticated;
grant all on public.operator_actions to service_role;

create policy "The operator reads operator actions"
  on public.operator_actions for select to authenticated
  using ((select public.is_operator()));

-- Returns the organization as it now is, or no row: for anyone but the operator, and for an
-- organization that does not exist. The row is locked first, so the limits recorded as "from"
-- are the ones this call replaced. The columns' own checks still bound every value.
create function public.operator_set_limits(
  org uuid,
  locations integer,
  queries_per_location integer,
  manual_scans_per_day integer,
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
        'max_locations', was.max_locations,
        'max_queries_per_location', was.max_queries_per_location,
        'max_manual_scans_per_day', was.max_manual_scans_per_day,
        'scan_every_days', was.scan_every_days
      ),
      'to', jsonb_build_object(
        'max_locations', locations,
        'max_queries_per_location', queries_per_location,
        'max_manual_scans_per_day', manual_scans_per_day,
        'scan_every_days', every_days
      )
    )
  );

  return query
    update public.organizations o
    set max_locations = locations,
        max_queries_per_location = queries_per_location,
        max_manual_scans_per_day = manual_scans_per_day,
        scan_every_days = every_days
    where o.id = org
    returning o.*;
end;
$$;

revoke execute on function public.operator_set_limits(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.operator_set_limits(uuid, integer, integer, integer, integer)
  to authenticated;
