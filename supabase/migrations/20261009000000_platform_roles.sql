-- Platform roles and test organizations (docs/adr/0003-platform-roles-and-test-accounts.md).
--
-- A platform role is what an account is to Nearcited itself, apart from any organization:
-- `operator` for the person who runs it, `test` for an account held by automation. Most accounts
-- have none. Organization roles (owner, admin, member) are untouched.

create type public.platform_role as enum ('operator', 'test');

create table public.platform_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.platform_role not null,
  created_at timestamptz not null default now()
);

comment on table public.platform_roles is
  'What an account is to the product as a whole. Written only with the secret key, by the operator.';

-- Nobody grants themselves a role: the API roles may read their own row and nothing else.
alter table public.platform_roles enable row level security;
revoke all on public.platform_roles from anon, authenticated;
grant select on public.platform_roles to authenticated;
grant all on public.platform_roles to service_role;

create policy "Accounts read their own platform role"
  on public.platform_roles for select to authenticated
  using (user_id = (select auth.uid()));

-- An organization made by a test account. Its scans run on generated sample data. Members cannot
-- set it: their update grant on organizations covers `name` alone.
alter table public.organizations
  add column is_test boolean not null default false;

comment on column public.organizations.is_test is
  'True when a test account created it. Its scans are generated sample data, and it is never a customer.';

-- Creating an organization marks it as a test organization when the caller is a test account,
-- and gives it room to exercise the product without meeting a limit.
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
        max_manual_scans_per_day = 500,
        scan_every_days = 1
    where id = org.id
    returning * into org;
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (org.id, caller, 'owner');

  return org;
end;
$$;
