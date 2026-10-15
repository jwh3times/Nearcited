-- Connecting a WordPress site, and the plans that include it (issue #140).
--
-- A WordPress connection is one site, and an owner connects it from the location whose website
-- it is. So the connection says which location it was made from, and the worker's first sync,
-- which is what finds the site the sign-in reaches, matches it to that location. Otherwise the
-- owner would connect on one page and choose the one thing it reaches on another. Nothing a
-- request says becomes a choice: the worker reads the site, and only then is it matched.
--
-- Publishing to a WordPress site goes on the Pro and Enterprise plans, and an organization
-- already on one of those is given it now, as it would be if the operator had set it: a plan
-- gaining something takes effect at once. Only this kind is touched. A test organization has had
-- it since the kind was added, and is never offered a WordPress connection all the same, since
-- nothing done for one leaves the product.
--
-- The Worker deployed before this migration keeps working. It calls create_connection() with
-- the arguments it always had, which still answer as before, and offers no WordPress connection.

insert into public.connection_kind_allowances (kind, allowance) values ('wordpress', 'wordpress');

alter table public.connections
  add column for_location uuid references public.locations (id) on delete set null;

comment on column public.connections.for_location is
  'The location an owner connected this from. The first sync matches it to that location, and clears this.';

-- create_connection() takes the location it was made from, which must be the organization's
-- own. Otherwise as before. Its arguments change, so it is made again.
drop function public.create_connection(uuid, uuid, public.connection_kind, text, text);

create function public.create_connection(
  org uuid,
  new_id uuid,
  of_kind public.connection_kind,
  account_label text,
  sealed_sign_in text,
  from_location uuid default null
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
  if from_location is not null and not exists (
    select 1 from public.locations l where l.id = from_location and l.organization_id = org
  ) then
    return;
  end if;
  if sealed_sign_in is null or sealed_sign_in = '' then
    raise exception 'A connection is made with its sign-in.' using errcode = '22023';
  end if;
  if not public.allows_connection(org, of_kind) then
    raise exception 'This organization''s plan does not include connecting this kind of account.'
      using errcode = 'NC012';
  end if;

  insert into public.connections
    (id, organization_id, kind, label, connected_by, connected_by_email, for_location)
  values (
    new_id,
    org,
    of_kind,
    btrim(account_label),
    caller,
    (select u.email from auth.users u where u.id = caller),
    from_location
  );
  insert into public.connection_secrets (connection_id, sealed) values (new_id, sealed_sign_in);

  return query select * from public.connections c where c.id = new_id;
end;
$$;

revoke execute on function
  public.create_connection(uuid, uuid, public.connection_kind, text, text, uuid)
  from public, anon;
grant execute on function
  public.create_connection(uuid, uuid, public.connection_kind, text, text, uuid)
  to authenticated;

-- A sync now also matches a connection to the location it was made from, once: to the one thing
-- it reaches, where it reaches exactly one, that location has no account of this kind and that
-- thing is no other location's. Whether it matched or not, the connection then no longer says
-- where it was made from: from then on, matching is the owner's. Otherwise as before.
create or replace function public.record_connection_sync(connection uuid, reached jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  c public.connections;
  only_choice jsonb;
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

  update public.connections x
  set choices = reached,
      last_synced_at = now(),
      status = 'working',
      failed_days = 0,
      last_failed_on = null,
      broken_reason = null,
      broken_at = null,
      broken_told_at = null,
      broken_reminded_at = null
  where x.id = connection
    and (x.status = 'working' or (x.status = 'broken' and x.broken_reason = 'failing'))
  returning x.* into c;
  if not found then
    return false;
  end if;

  update public.connection_locations m
  set external_label = e ->> 'label'
  from jsonb_array_elements(reached) e
  where m.connection_id = connection
    and m.external_id = e ->> 'id'
    and m.external_label is distinct from e ->> 'label';

  if c.for_location is not null then
    if jsonb_array_length(reached) = 1 then
      only_choice := reached -> 0;
      insert into public.connection_locations
        (connection_id, kind, location_id, external_id, external_label)
      select connection, c.kind, c.for_location, only_choice ->> 'id', only_choice ->> 'label'
      where not exists (
          select 1 from public.connection_locations m
          where m.location_id = c.for_location and m.kind = c.kind
        )
        and not exists (
          select 1 from public.connection_locations m
          where m.connection_id = connection and m.external_id = only_choice ->> 'id'
        );
    end if;
    update public.connections set for_location = null where id = connection;
  end if;
  return true;
end;
$$;

update public.plans p
set allowances = p.allowances || jsonb_build_object('wordpress', true),
    updated_at = now()
where p.key in ('pro', 'enterprise');

update public.organizations o
set allowances = o.allowances || jsonb_build_object('wordpress', true)
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'wordpress'
  and not o.is_test;
