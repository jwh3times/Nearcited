-- Connections: an owner's standing sign-in to an outside account (issue #134,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md).
--
-- A connection belongs to the organization: its owner signs in once, and each location is later
-- matched to its own profile, site or property. This first step makes one and removes one.
-- Syncing, matching locations, and what happens when one breaks or the plan stops including it
-- come after.
--
-- The sign-in itself is a secret that belongs to someone else. The Worker seals it before it
-- reaches the database, with a key only the Worker holds, and it is kept in a table no API role
-- can read. A copy of the database alone opens nothing.
--
-- The Worker deployed before this migration is not touched by it: it reads none of this.

-- The kinds of account that can be connected. `sample` stands in for a real one on sample data,
-- so the pages and the worker can be exercised without an outside account.
create type public.connection_kind as enum ('sample');

-- Where a connection stands. `broken` and `paused` are set by later steps: a sign-in the outside
-- service refuses, and a plan that no longer includes this kind of work.
create type public.connection_status as enum ('working', 'broken', 'paused', 'removing', 'removed');

create table public.connections (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind public.connection_kind not null,
  -- What its owner knows the account by at the outside service.
  label text not null check (char_length(label) between 1 and 120),
  status public.connection_status not null default 'working',
  -- Who connected it, kept as the address they had then, so the record outlives the account.
  connected_by uuid references auth.users (id) on delete set null,
  connected_by_email text,
  connected_at timestamptz not null default now(),
  -- Who asked for it to be removed, and when. The worker then withdraws access and deletes the
  -- sign-in, and `removed_at` is when that was done.
  removed_by uuid references auth.users (id) on delete set null,
  removed_by_email text,
  removal_requested_at timestamptz,
  removed_at timestamptz
);

comment on table public.connections is
  'An organization''s standing sign-in to an outside account. The sign-in itself is in connection_secrets.';

create index connections_organization on public.connections (organization_id);

create table public.connection_secrets (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  -- The sign-in, sealed by the Worker. Nothing in the database can open it.
  sealed text not null,
  updated_at timestamptz not null default now()
);

comment on table public.connection_secrets is
  'A connection''s sign-in, sealed by the Worker. Read and written only by the worker.';

-- An organization's members read its connections, and the operator reads everyone's. Nobody
-- writes one through the API except by the functions below, which ask who is calling.
alter table public.connections enable row level security;
revoke all on public.connections from public, anon, authenticated;
grant select on public.connections to authenticated;
grant all on public.connections to service_role;

create policy "Members read their organization's connections"
  on public.connections for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads connections"
  on public.connections for select to authenticated
  using ((select public.is_operator()));

-- No API role reads or writes a sign-in, sealed or not, and there is no policy to let one.
alter table public.connection_secrets enable row level security;
revoke all on public.connection_secrets from public, anon, authenticated;
grant all on public.connection_secrets to service_role;

-- Makes a connection for an organization, with its sealed sign-in, in one transaction. The
-- Worker chooses the ID first, because the sign-in is sealed to it. Answers only an owner or
-- admin of the organization: for anyone else, no row.
create function public.create_connection(
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

revoke execute on function
  public.create_connection(uuid, uuid, public.connection_kind, text, text)
  from public, anon;
grant execute on function
  public.create_connection(uuid, uuid, public.connection_kind, text, text)
  to authenticated;

-- Asks for a connection to be removed. It stops being used at once; the worker then withdraws
-- access at the outside service and deletes the sign-in, which only it can read. Answers only an
-- owner or admin of the connection's organization: for anyone else, no row. Asking twice changes
-- nothing the second time.
create function public.request_connection_removal(connection uuid)
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
        removed_by = caller,
        removed_by_email = (select u.email from auth.users u where u.id = caller),
        removal_requested_at = now()
    where id = connection;
  end if;

  return query select * from public.connections x where x.id = connection;
end;
$$;

revoke execute on function public.request_connection_removal(uuid) from public, anon;
grant execute on function public.request_connection_removal(uuid) to authenticated;

-- Finishes a removal that was asked for: the sign-in is deleted and the connection is marked
-- removed. The row stays, as the record of who connected it and who removed it. Worker only.
-- Returns true when it finished one, false when there was none waiting.
create function public.finish_connection_removal(connection uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections
  set status = 'removed', removed_at = now()
  where id = connection and status = 'removing';
  if not found then
    return false;
  end if;

  delete from public.connection_secrets where connection_id = connection;
  return true;
end;
$$;

revoke execute on function public.finish_connection_removal(uuid) from public, anon, authenticated;
grant execute on function public.finish_connection_removal(uuid) to service_role;
