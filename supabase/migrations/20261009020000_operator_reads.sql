-- The operator reads everything (docs/adr/0004-the-operator-reads-through-policies.md).
--
-- The person who runs Nearcited needs to see every organization's data to know what is broken
-- and to help. They get it the way every member gets theirs: a policy the database enforces, not
-- a key that bypasses the policies. Only `select` policies are added, so the database itself
-- guarantees the operator's view is read-only outside their own organization.

create function public.is_operator()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_roles r
    where r.user_id = (select auth.uid()) and r.role = 'operator'
  );
$$;

revoke execute on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated;

-- One policy per table. `(select ...)` so the role is looked up once per query, not per row.
create policy "The operator reads organizations"
  on public.organizations for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads memberships"
  on public.memberships for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads locations"
  on public.locations for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads tracked queries"
  on public.tracked_queries for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads scans"
  on public.scans for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads scan results"
  on public.scan_results for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads recommendations"
  on public.recommendations for select to authenticated
  using ((select public.is_operator()));

create policy "The operator reads platform roles"
  on public.platform_roles for select to authenticated
  using ((select public.is_operator()));

-- These two were closed to the API roles outright. They stay closed to everyone but the
-- operator: the grant lets a signed-in account ask, and the only policy answers the operator.
grant select on public.audits to authenticated;
create policy "The operator reads audits"
  on public.audits for select to authenticated
  using ((select public.is_operator()));

grant select on public.provider_usage to authenticated;
create policy "The operator reads provider usage"
  on public.provider_usage for select to authenticated
  using ((select public.is_operator()));

-- "My organizations" used to be "every organization I can read", which was the same thing until
-- the operator could read them all. It is now asked for by membership.
create function public.my_organizations()
returns setof public.organizations
language sql stable set search_path = ''
as $$
  select o.*
  from public.organizations o
  where public.is_org_member(o.id)
  order by o.created_at;
$$;

revoke execute on function public.my_organizations() from public, anon;
grant execute on function public.my_organizations() to authenticated, service_role;
