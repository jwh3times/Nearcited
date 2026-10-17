-- Closing an account (issue #210, docs/adr/0020-the-worker-closes-an-account.md). An owner asks,
-- typing the organization's name, and the worker does the rest: it cancels the subscription,
-- removes every connection, deletes the organization and then the owner's sign-in, and sends
-- one email. A request only records the ask, through request_closing().
--
-- The Worker deployed before this migration goes on working: it adds a column nothing reads yet,
-- a table, two functions and a reason for removing a connection, and the functions it replaces
-- keep their names, arguments and what they return. Nothing asks to close an account until the
-- new Worker offers it; a connection removed for that reason before then would only fail to
-- show on the old Worker's Connections page, for the minute until its organization is gone.

-- When an owner asked for the organization to be closed. Set by request_closing() alone: a
-- member may write only the name.
alter table public.organizations add column closing_at timestamptz;

comment on column public.organizations.closing_at is
  'When an owner asked for it to be closed. From then its members cannot reach it and the worker does nothing more for it but close it.';

-- A sign-in can be deleted while an organization it made is still there. Closing deletes the
-- organization first, but its creator may be someone who has since left it.
alter table public.organizations alter column created_by drop not null;
alter table public.organizations drop constraint organizations_created_by_fkey;
alter table public.organizations add constraint organizations_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- A connection removed because its account is being closed. Its removal sends no email of its
-- own: the closing sends one.
alter table public.connections drop constraint connections_removal_reason_check;
alter table public.connections add constraint connections_removal_reason_check
  check (removal_reason in ('asked', 'plan', 'unclaimed', 'location', 'closing'));

-- A one-way fingerprint of an email address: the same for the same address however it is
-- written, and no way back to it.
create function public.email_fingerprint(email text)
returns text
language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(lower(btrim(email)), 'UTF8')), 'hex');
$$;

revoke execute on function public.email_fingerprint(text) from public, anon, authenticated;
grant execute on function public.email_fingerprint(text) to service_role;

-- Each ask to close, and how far the worker has got with it. It has no foreign key to the
-- organization, which it outlives: what the closing email needs is kept here until the email has
-- gone, and then only the fingerprint of the owner's email and the day, for thirty days, beside
-- the organization's id, which names nothing once the organization is gone. No API
-- role reads or writes it. The worker reaches it with the secret key, which bypasses policies.
create table public.closings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique,
  organization_name text,
  owner_id uuid,
  owner_email text,
  member_emails text[] not null default '{}',
  fingerprint text not null,
  asked_at timestamptz not null default now(),
  cancelled_at timestamptz,
  had_subscription boolean not null default false,
  left_at_sites text[] not null default '{}',
  hostnames text[] not null default '{}',
  organization_deleted_at timestamptz,
  account_deleted_at timestamptz,
  -- When the owner's email went, and the note to everyone else, so neither goes twice.
  told_at timestamptz,
  noted_at timestamptz,
  -- Since when a worker has been on it. Another leaves it alone for ten minutes.
  working_since timestamptz,
  finished_at timestamptz
);

create index closings_fingerprint on public.closings (fingerprint);
create index closings_unfinished on public.closings (asked_at) where finished_at is null;

alter table public.closings enable row level security;
-- No policies: nobody signed in, nor anyone signed out, reads or writes a row.
revoke all on public.closings from public, anon, authenticated;
grant select, insert, update, delete on public.closings to service_role;

-- The worker takes a closing to work on: not one that is finished, nor one another worker took
-- in the last ten minutes. True when it was taken. Worker only.
create function public.claim_closing(closing uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  with taken as (
    update public.closings c
    set working_since = now()
    where c.id = closing
      and c.finished_at is null
      and (c.working_since is null or c.working_since < now() - interval '10 minutes')
    returning c.id
  )
  select exists (select 1 from taken);
$$;

revoke execute on function public.claim_closing(uuid) from public, anon, authenticated;
grant execute on function public.claim_closing(uuid) to service_role;

-- An owner's ask to close the organization, the name typed out to say they mean it. Answers with
-- the closing, or why not:
--
--   owners_only    the caller is not an owner of it, or it is not there
--   not_closable   the operator, a test account or a test organization: closed by hand, if at all
--   name_mismatch  the name typed is not the organization's
--
-- Marks the organization closing and every connection of it for removal, and keeps what the
-- worker and its email need. Asking again for one already closing gives the same closing.
create function public.request_closing(org uuid, typed_name text)
returns table (closing_id uuid, refused text)
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  o public.organizations;
  owner_email text;
  made uuid;
begin
  -- Whether the caller may ask comes first, so a stranger locks nothing.
  if caller is null or not exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = caller and m.role = 'owner'
  ) then
    return query select null::uuid, 'owners_only'::text;
    return;
  end if;
  select * into o from public.organizations where id = org for update;
  if not found then
    return query select null::uuid, 'owners_only'::text;
    return;
  end if;
  if o.is_test or exists (select 1 from public.platform_roles r where r.user_id = caller) then
    return query select null::uuid, 'not_closable'::text;
    return;
  end if;
  if o.closing_at is not null then
    return query select c.id, null::text from public.closings c where c.organization_id = org;
    return;
  end if;
  if btrim(coalesce(typed_name, '')) <> btrim(o.name) then
    return query select null::uuid, 'name_mismatch'::text;
    return;
  end if;

  select u.email into owner_email from auth.users u where u.id = caller;
  update public.organizations set closing_at = now() where id = org;
  -- Each connection is removed the way an owner removes one, by the worker.
  update public.connections
  set status = 'removing', removal_reason = 'closing', removal_requested_at = now(),
      removed_by = caller, removed_by_email = owner_email
  where organization_id = org and status not in ('removing', 'removed');

  insert into public.closings (
    organization_id, organization_name, owner_id, owner_email, member_emails, fingerprint
  )
  values (
    org, o.name, caller, owner_email,
    coalesce((
      select array_agg(u.email order by u.email)
      from public.memberships m
      join auth.users u on u.id = m.user_id
      where m.organization_id = org and m.user_id <> caller and u.email is not null
    ), '{}'),
    public.email_fingerprint(coalesce(owner_email, caller::text))
  )
  returning id into made;

  return query select made, null::text;
end;
$$;

revoke execute on function public.request_closing(uuid, text) from public, anon;
grant execute on function public.request_closing(uuid, text) to authenticated;

-- An organization being closed is out of its members' reach from the moment it is asked: every
-- policy that asks whether the caller belongs reads one of these. Otherwise as before.
create or replace function public.is_org_member(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org and m.user_id = (select auth.uid()) and o.closing_at is null
  );
$$;

create or replace function public.has_org_role(org uuid, roles public.member_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.role = any (roles)
      and o.closing_at is null
  );
$$;

create or replace function public.can_access_location(loc uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.locations l
    join public.memberships m on m.organization_id = l.organization_id
    join public.organizations o on o.id = l.organization_id
    where l.id = loc and m.user_id = (select auth.uid()) and o.closing_at is null
  );
$$;

create or replace function public.can_access_scan(scan uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.scans s
    join public.locations l on l.id = s.location_id
    join public.memberships m on m.organization_id = l.organization_id
    join public.organizations o on o.id = l.organization_id
    where s.id = scan and m.user_id = (select auth.uid()) and o.closing_at is null
  );
$$;

-- Where billing stands, and the assistants chosen, are no longer an owner's to read or change
-- once they asked for the organization to be closed: no checkout is started for it, and nothing
-- about it changes but its closing. Otherwise as before.
create or replace function public.billing_state(org uuid)
returns table (
  organization_id uuid,
  is_test boolean,
  plan_key text,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text
)
language sql stable security definer set search_path = ''
as $$
  select o.id, o.is_test, o.plan_key, s.stripe_customer_id, s.stripe_subscription_id, s.status
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  where o.id = org
    and o.closing_at is null
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;

create or replace function public.choose_assistants(org uuid, chosen public.surface[])
returns setof public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  allowed integer;
  picked public.surface[];
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;

  select p.assistants into allowed
  from public.organizations o
  join public.plans p on p.key = o.plan_key
  where o.id = org
  for update of o;

  if not found then
    raise exception 'This organization''s assistants were set for it and cannot be changed here.'
      using errcode = 'NC004';
  end if;

  -- In a fixed order and without repeats, whatever order they were sent in.
  select coalesce(array_agg(s order by s), '{}') into picked
  from (select distinct unnest(chosen) as s) given;

  if not (picked <@ array['chatgpt', 'claude']::public.surface[]) then
    raise exception 'Choose from ChatGPT and Claude.' using errcode = 'NC004';
  end if;
  if cardinality(picked) <> least(allowed, 2) then
    raise exception 'This organization''s plan checks % %. Choose exactly that many.',
      least(allowed, 2), case when least(allowed, 2) = 1 then 'assistant' else 'assistants' end
      using errcode = 'NC004';
  end if;

  return query
    update public.organizations o set surfaces = picked where o.id = org returning o.*;
end;
$$;

-- Nothing more is carried out for an organization being closed. Otherwise as before.
create or replace function public.organization_held(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o where o.id = org and o.closing_at is not null
  ) or exists (
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

-- Nothing is scanned for an organization being closed. Otherwise as before.
create or replace function public.locations_due_for_scan(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select l.id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where not l.paused_by_plan
    and o.closing_at is null
    and exists (
      select 1 from public.tracked_queries q where q.location_id = l.id and q.is_active
    )
    and not exists (
      select 1 from public.scans s
      where s.location_id = l.id
        and s.status in ('queued', 'running')
        and s.created_at > now() - interval '6 hours'
    )
    and (
      l.last_scanned_at is null
      or l.last_scanned_at < now() - make_interval(days => o.scan_every_days) + interval '4 hours'
    )
  order by l.last_scanned_at asc nulls first
  limit max_rows;
$$;

-- Nothing is written for an organization being closed. Otherwise as before.
create or replace function public.claim_draft(draft uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  claim record;
  took date;
  try integer;
begin
  select * into d from public.drafts where id = draft for update;
  if not found or d.status <> 'asked'
    or (d.writing_since is not null and d.writing_since >= now() - interval '10 minutes')
    or exists (
      select 1 from public.locations l
      join public.organizations o on o.id = l.organization_id
      where l.id = d.location_id and o.closing_at is not null
    )
  then
    return 0;
  end if;

  if d.allowance_month is null then
    select * into claim from public.claim_allowance(
      (select l.organization_id from public.locations l where l.id = d.location_id), 'drafts');
    if not coalesce(claim.claimed, false) then
      update public.drafts
      set status = 'failed', writing_since = null,
          failure = 'Your plan has no more drafts this month.'
      where id = draft;
      return 0;
    end if;
    took := date_trunc('month', now() at time zone 'UTC')::date;
  end if;

  update public.drafts
  set writing_since = now(), attempts = attempts + 1,
      allowance_month = coalesce(took, allowance_month)
  where id = draft
  returning attempts into try;
  return try;
end;
$$;

-- An organization made from the address of an account closed in the last thirty days starts
-- with its free first scan already used, so closing is not a way to a fresh one. Otherwise as
-- before.
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
        scan_every_days = 1,
        allowances = public.test_allowances()
    where id = org.id
    returning * into org;
  else
    org := public.apply_plan(org.id, 'free');
    if exists (
      select 1 from public.closings c
      where c.fingerprint = public.email_fingerprint(
          (select u.email from auth.users u where u.id = caller))
        and coalesce(c.finished_at, c.asked_at) > now() - interval '30 days'
    ) then
      update public.organizations set first_scan_at = now() where id = org.id
      returning * into org;
    end if;
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (org.id, caller, 'owner');

  return org;
end;
$$;
