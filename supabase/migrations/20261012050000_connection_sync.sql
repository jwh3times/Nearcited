-- Syncing from a connection, and matching each location to what its sign-in reaches (issue #134,
-- docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md).
--
-- A sign-in usually reaches several things: every profile an account manages, every site it
-- owns. The worker reads that list on each sync and keeps it on the connection, and an owner or
-- admin then says which of them is each location's. Only the worker reads the list from the
-- outside service, because only it can read the sign-in.
--
-- The Worker deployed before this migration is not touched by it: it names the columns it reads
-- and calls none of the functions added here. `finish_connection_removal()` keeps its name and
-- its arguments.

alter table public.connections
  add column last_synced_at timestamptz,
  -- What the sign-in can reach, as the last sync found it: [{"id": "...", "label": "..."}].
  add column choices jsonb not null default '[]'::jsonb
    check (jsonb_typeof(choices) = 'array');

comment on column public.connections.choices is
  'What the sign-in can reach, as the last sync found it. Written only by the worker.';

-- So that a match can name its connection's kind and be held to it.
alter table public.connections add constraint connections_id_kind unique (id, kind);

-- Which of a connection's choices is a location's.
create table public.connection_locations (
  connection_id uuid not null,
  kind public.connection_kind not null,
  location_id uuid not null references public.locations (id) on delete cascade,
  external_id text not null check (char_length(external_id) between 1 and 300),
  -- What it was called when it was chosen, or at the last sync since.
  external_label text not null,
  matched_at timestamptz not null default now(),
  primary key (connection_id, location_id),
  -- One account of a kind for a location: two would leave no saying which of them acts.
  unique (location_id, kind),
  -- And one location for each thing an account reaches.
  unique (connection_id, external_id),
  foreign key (connection_id, kind) references public.connections (id, kind) on delete cascade
);

comment on table public.connection_locations is
  'Which profile, site or property of a connection belongs to which location.';

-- Read by whoever can read the location, and by the operator. Written only through the
-- functions below, which ask who is calling.
alter table public.connection_locations enable row level security;
revoke all on public.connection_locations from public, anon, authenticated;
grant select on public.connection_locations to authenticated;
grant all on public.connection_locations to service_role;

create policy "Members read what their locations are matched to"
  on public.connection_locations for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads what locations are matched to"
  on public.connection_locations for select to authenticated
  using ((select public.is_operator()));

-- Says which of a connection's choices is a location's, replacing what was said before. Answers
-- only an owner or admin of the connection's organization, and only for one of its own
-- locations: for anyone and anything else, no row. Refuses, with the reason, a choice the
-- account does not reach, one that is already another location's, and a location that already
-- has an account of this kind.
create function public.match_connection_location(connection uuid, location uuid, external text)
returns setof public.connection_locations
language plpgsql security definer set search_path = ''
as $$
declare
  c public.connections;
  choice jsonb;
begin
  select * into c from public.connections where id = connection for update;
  if not found
    or not public.has_org_role(c.organization_id, array['owner', 'admin']::public.member_role[])
    or not exists (
      select 1 from public.locations l
      where l.id = location and l.organization_id = c.organization_id
    )
  then
    return;
  end if;

  if c.status <> 'working' then
    raise exception 'This account is not connected any more.' using errcode = 'NC012';
  end if;

  select e into choice from jsonb_array_elements(c.choices) e where e ->> 'id' = external limit 1;
  if choice is null then
    raise exception 'That is not something this account reaches.' using errcode = 'NC012';
  end if;

  if exists (
    select 1 from public.connection_locations m
    where m.connection_id = connection and m.external_id = external and m.location_id <> location
  ) then
    raise exception 'That already belongs to another location. Take it from that one first.'
      using errcode = 'NC012';
  end if;
  if exists (
    select 1 from public.connection_locations m
    where m.location_id = location and m.kind = c.kind and m.connection_id <> connection
  ) then
    raise exception 'This location is matched to another account of the same kind. Take it from that one first.'
      using errcode = 'NC012';
  end if;

  insert into public.connection_locations as m
    (connection_id, kind, location_id, external_id, external_label)
  values (connection, c.kind, location, external, choice ->> 'label')
  on conflict (connection_id, location_id) do update
    set external_id = excluded.external_id,
        external_label = excluded.external_label,
        matched_at = now();

  return query
    select * from public.connection_locations m
    where m.connection_id = connection and m.location_id = location;
end;
$$;

revoke execute on function public.match_connection_location(uuid, uuid, text) from public, anon;
grant execute on function public.match_connection_location(uuid, uuid, text) to authenticated;

-- Takes a location's match away. Answers only an owner or admin of the connection's
-- organization. True when there was one to take.
create function public.unmatch_connection_location(connection uuid, location uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
begin
  select c.organization_id into org from public.connections c where c.id = connection;
  if org is null
    or not public.has_org_role(org, array['owner', 'admin']::public.member_role[])
  then
    return false;
  end if;

  delete from public.connection_locations m
  where m.connection_id = connection and m.location_id = location;
  return found;
end;
$$;

revoke execute on function public.unmatch_connection_location(uuid, uuid) from public, anon;
grant execute on function public.unmatch_connection_location(uuid, uuid) to authenticated;

-- The connections to sync now: working ones never synced, or last synced most of a day ago,
-- longest-waiting first. Worker only: the daily run calls it.
create function public.connections_due_for_sync(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select c.id
  from public.connections c
  where c.status = 'working'
    and (c.last_synced_at is null or c.last_synced_at < now() - interval '20 hours')
  order by c.last_synced_at asc nulls first
  limit max_rows;
$$;

revoke execute on function public.connections_due_for_sync(integer) from public, anon, authenticated;
grant execute on function public.connections_due_for_sync(integer) to service_role;

-- Keeps what a sync found: what the sign-in reaches, and when it was read. A match keeps its
-- choice, and takes the name the choice has now. Worker only. False for a connection that is not
-- working, which is left as it is.
create function public.record_connection_sync(connection uuid, reached jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
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

  update public.connections
  set choices = reached, last_synced_at = now()
  where id = connection and status = 'working';
  if not found then
    return false;
  end if;

  update public.connection_locations m
  set external_label = e ->> 'label'
  from jsonb_array_elements(reached) e
  where m.connection_id = connection
    and m.external_id = e ->> 'id'
    and m.external_label is distinct from e ->> 'label';
  return true;
end;
$$;

revoke execute on function public.record_connection_sync(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_connection_sync(uuid, jsonb) to service_role;

-- Finishing a removal now also deletes what was synced: what the sign-in reached, and which
-- location each was matched to. Otherwise as before.
create or replace function public.finish_connection_removal(connection uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections
  set status = 'removed', removed_at = now(), choices = '[]'::jsonb
  where id = connection and status = 'removing';
  if not found then
    return false;
  end if;

  delete from public.connection_secrets where connection_id = connection;
  delete from public.connection_locations where connection_id = connection;
  return true;
end;
$$;
