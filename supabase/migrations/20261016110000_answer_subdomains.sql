-- Answer subdomains: a subdomain of a business's own domain that the product serves pages on
-- (issue #141, docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md).
--
-- An owner or admin chooses one word, and the subdomain is that word in front of the location's
-- website's domain. It is a connection of the `hosted_pages` kind, matched to its location at once
-- and with no sign-in. Its record points at a target of its own under pages.nearcited.com, and the
-- worker registers the name to be served only once the record points there: a name is the
-- account's whose target its owner's DNS names, so another account that made it first gets
-- nothing. A name is held by one connection at a time, across every organization, until its
-- removal is finished.
--
-- A location publishes its pages to one place: an answer subdomain and a WordPress site refuse
-- each other.
--
-- The Worker deployed before this migration keeps working. It calls create_connection() and
-- finish_connection_removal() with the arguments they had, which answer as before for every kind
-- it knows, and it reads no answer subdomain. A connection removed as `unclaimed` is made thirty
-- days after the first answer subdomain at the earliest, by which time it is deployed.

insert into public.connection_kind_allowances (kind, allowance) values ('hosted_pages', 'hosted_pages');

-- Why a connection was removed now also takes `unclaimed`, an answer subdomain that never started
-- working, and `location`, one whose location was removed.
alter table public.connections drop constraint connections_removal_reason_check;
alter table public.connections add constraint connections_removal_reason_check
  check (removal_reason in ('asked', 'plan', 'unclaimed', 'location'));

create table public.answer_subdomains (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  hostname text not null check (hostname ~ '^[a-z0-9.-]+$' and char_length(hostname) <= 253),
  -- The connection's own name under pages.nearcited.com, which its record points at.
  target text not null unique check (target ~ '^[a-z0-9]{12}$'),
  -- What the name pointed at when the worker last looked.
  record text check (record in ('missing', 'ours', 'proxied', 'elsewhere')),
  checked_at timestamptz,
  -- What Cloudflare calls the name once it is registered to be served. Worker only.
  cloudflare_id text,
  registered_at timestamptz,
  -- When it was first served with its certificate, and when the owners were told. The second is
  -- the worker's own.
  live_at timestamptz,
  live_told_at timestamptz,
  -- Whether the business's home page links to it, as the worker last read it.
  home_links boolean,
  -- When its removal was finished and the name let go.
  released_at timestamptz
);

comment on table public.answer_subdomains is
  'A location''s answer subdomain: a hosted_pages connection''s name, target and what the worker found.';

-- One connection holds a name at a time.
create unique index answer_subdomains_held on public.answer_subdomains (hostname)
  where released_at is null;
create index answer_subdomains_location on public.answer_subdomains (location_id);

-- A member reads their location's answer subdomain, and the operator reads every one, but not
-- what the worker keeps for itself. Nothing writes one through the API except the function below.
alter table public.answer_subdomains enable row level security;
revoke all on public.answer_subdomains from public, anon, authenticated;
grant select (
  connection_id, organization_id, location_id, hostname, target, record, checked_at,
  registered_at, live_at, home_links, released_at
) on public.answer_subdomains to authenticated;
grant all on public.answer_subdomains to service_role;

create policy "Members read their organization's answer subdomains"
  on public.answer_subdomains for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads answer subdomains"
  on public.answer_subdomains for select to authenticated
  using ((select public.is_operator()));

-- The domain an answer subdomain goes under: a website's host, lower case and without `www.`.
-- Null where the address has none. The shared package works out the same in websiteDomain().
create function public.website_domain(website text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(coalesce(website, '')), '^[a-z][a-z0-9+.-]*://', ''),
      '^www\.|[:/?#].*$', '', 'g'
    ),
    ''
  );
$$;

-- Makes a location's answer subdomain: `label` in front of its website's domain, held by a new
-- connection of the hosted_pages kind matched to the location, with no sign-in. Answers only an
-- owner or admin of the location's organization: for anyone else, no row. Refuses, with the
-- reason, a test organization, a plan without hosted pages, a location without a website or that
-- publishes its pages somewhere already, and a word that is not one; and with a unique violation,
-- a name another connection holds.
create function public.create_answer_subdomain(
  location uuid,
  new_id uuid,
  label text,
  new_target text
)
returns setof public.connections
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  l public.locations;
  o public.organizations;
  domain text;
  host text;
begin
  select * into l from public.locations x where x.id = location;
  if not found
    or not public.has_org_role(l.organization_id, array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;
  select * into o from public.organizations x where x.id = l.organization_id;
  if o.is_test then
    raise exception 'A test organization''s pages would go out under a real domain.'
      using errcode = 'NC012';
  end if;
  if not public.allows_connection(o.id, 'hosted_pages') then
    raise exception 'This organization''s plan does not include hosted pages.'
      using errcode = 'NC012';
  end if;
  domain := public.website_domain(l.website);
  if domain is null or position('.' in domain) = 0
    or label is null or label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  then
    raise exception 'That is not a subdomain of this location''s website.' using errcode = 'NC012';
  end if;
  if exists (
    select 1 from public.connection_locations m
    join public.connections c on c.id = m.connection_id
    where m.location_id = location and m.kind in ('wordpress', 'hosted_pages')
      and c.status <> 'removed'
  ) or exists (
    select 1 from public.connections c
    where c.for_location = location and c.kind = 'wordpress' and c.status <> 'removed'
  ) then
    raise exception 'This location already publishes its pages somewhere.' using errcode = 'NC012';
  end if;
  host := label || '.' || domain;

  insert into public.connections
    (id, organization_id, kind, label, connected_by, connected_by_email, choices, last_synced_at)
  values (
    new_id,
    o.id,
    'hosted_pages',
    host,
    caller,
    (select u.email from auth.users u where u.id = caller),
    jsonb_build_array(jsonb_build_object('id', host, 'label', host)),
    null
  );
  insert into public.connection_locations
    (connection_id, kind, location_id, external_id, external_label)
  values (new_id, 'hosted_pages', location, host, host);
  insert into public.answer_subdomains (connection_id, organization_id, location_id, hostname, target)
  values (new_id, o.id, location, host, new_target);

  return query select * from public.connections c where c.id = new_id;
end;
$$;

revoke execute on function public.create_answer_subdomain(uuid, uuid, text, text) from public, anon;
grant execute on function public.create_answer_subdomain(uuid, uuid, text, text) to authenticated;

-- A WordPress site is now refused for a location whose pages are hosted on its answer subdomain.
-- Otherwise as before.
create or replace function public.create_connection(
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
  if of_kind = 'hosted_pages' then
    raise exception 'An answer subdomain is made with create_answer_subdomain().'
      using errcode = '22023';
  end if;
  if not public.allows_connection(org, of_kind) then
    raise exception 'This organization''s plan does not include connecting this kind of account.'
      using errcode = 'NC012';
  end if;
  if of_kind = 'wordpress' and from_location is not null and exists (
    select 1 from public.connection_locations m
    join public.connections c on c.id = m.connection_id
    where m.location_id = from_location and m.kind = 'hosted_pages' and c.status <> 'removed'
  ) then
    raise exception 'This location''s pages are hosted on its answer subdomain.'
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

-- Keeps what a check of an answer subdomain found, as a sync: what its name points at, the name
-- Cloudflare registered it under, whether it is live, and whether the home page links to it. A
-- check that succeeds mends a connection that had only kept failing, as a sync does. Worker only.
-- False for a connection that is neither working nor failing.
create function public.record_answer_subdomain_check(
  connection uuid,
  seen text,
  registered text,
  live boolean,
  links boolean
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections x
  set last_synced_at = now(),
      status = 'working',
      failed_days = 0,
      last_failed_on = null,
      broken_reason = null,
      broken_at = null,
      broken_told_at = null,
      broken_reminded_at = null
  where x.id = connection and x.kind = 'hosted_pages'
    and (x.status = 'working' or (x.status = 'broken' and x.broken_reason = 'failing'));
  if not found then
    return false;
  end if;

  update public.answer_subdomains a
  set record = seen,
      checked_at = now(),
      cloudflare_id = coalesce(registered, a.cloudflare_id),
      registered_at = case
        when a.registered_at is null and registered is not null then now()
        else a.registered_at
      end,
      live_at = case when a.live_at is null and live then now() else a.live_at end,
      home_links = coalesce(links, a.home_links)
  where a.connection_id = connection;
  return true;
end;
$$;

revoke execute on function public.record_answer_subdomain_check(uuid, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.record_answer_subdomain_check(uuid, text, text, boolean, boolean)
  to service_role;

-- The working answer subdomains not yet live, made in the last thirty days and not checked since
-- `before`: the ones the schedule checks every few minutes, so an owner who has just added the
-- record sees it work soon. Worker only.
create function public.answer_subdomains_to_check(before timestamptz)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select a.connection_id
  from public.answer_subdomains a
  join public.connections c on c.id = a.connection_id
  where c.status = 'working'
    and a.live_at is null
    and c.connected_at > now() - interval '30 days'
    and (a.checked_at is null or a.checked_at < before)
  order by a.checked_at asc nulls first
  limit 100;
$$;

revoke execute on function public.answer_subdomains_to_check(timestamptz) from public, anon, authenticated;
grant execute on function public.answer_subdomains_to_check(timestamptz) to service_role;

-- Starts the removal of every answer subdomain that has not started working in thirty days: its
-- record never appeared, or its certificate was never issued. The name is then anyone's again.
-- The worker finishes each, takes it off Cloudflare where it was registered, and tells its owners.
-- Worker only.
create function public.expire_unclaimed_answer_subdomains()
returns setof uuid
language sql security definer set search_path = ''
as $$
  update public.connections c
  set status = 'removing', removal_reason = 'unclaimed', removal_requested_at = now()
  from public.answer_subdomains a
  where a.connection_id = c.id
    and c.status in ('working', 'broken')
    and a.live_at is null
    and c.connected_at < now() - interval '30 days'
  returning c.id;
$$;

revoke execute on function public.expire_unclaimed_answer_subdomains() from public, anon, authenticated;
grant execute on function public.expire_unclaimed_answer_subdomains() to service_role;

-- Finishing a removal now also lets an answer subdomain's name go. Otherwise as before.
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
  update public.answer_subdomains set released_at = now()
  where connection_id = connection and released_at is null;
  return true;
end;
$$;

-- A location's answer subdomain is removed with the location: nothing is left to serve there.
-- The worker finishes it as any removal, takes the name off Cloudflare and tells the owners to
-- delete their record.
create function public.remove_answer_subdomain_of_location()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections c
  set status = 'removing', removal_reason = 'location', removal_requested_at = now()
  from public.answer_subdomains a
  where a.connection_id = c.id
    and a.location_id = old.id
    and c.status not in ('removing', 'removed');
  return old;
end;
$$;

revoke execute on function public.remove_answer_subdomain_of_location() from public, anon, authenticated;

create trigger remove_answer_subdomain_of_location
  before delete on public.locations
  for each row execute function public.remove_answer_subdomain_of_location();

-- Hosted pages go on the Pro and Enterprise plans, and an organization already on one of those is
-- given them now, as it would be if the operator had set it: a plan gaining something takes
-- effect at once. Only this kind is touched.
update public.plans p
set allowances = p.allowances || jsonb_build_object('hosted_pages', true),
    updated_at = now()
where p.key in ('pro', 'enterprise');

update public.organizations o
set allowances = o.allowances || jsonb_build_object('hosted_pages', true)
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'hosted_pages'
  and not o.is_test;
