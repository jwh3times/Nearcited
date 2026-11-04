-- Receiving copied receipts as customer contacts (issue #291, part of #146,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md).
--
-- The business's own tool copies each receipt it sends a customer to the location's receipt
-- address. The Worker's email handler reads it, and the worker keeps the customer's address and
-- the day of the job, and nothing else, as a customer contact. A receipt from a sender an owner or
-- admin has not confirmed is held, for up to seven days; one from a sender they declined, and one
-- that cannot be read with certainty, is dropped and counted for the location.
--
-- Only the worker reads a contact's full address. Members, owners, admins and the operator read
-- it masked, as `j•••@gmail.com`, and the day: the column holding it is granted to no API role.
-- export_organization() leaves contacts out, as it always has.
--
-- The Worker deployed before this migration is not touched by it: it reads none of these tables
-- and calls none of these functions.

-- The addresses that send receipts to a location's receipt address: its owner's own tool, once an
-- owner or admin confirms it. A sender is not a customer: its address is shown whole.
create table public.receipt_senders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  address text not null check (char_length(address) <= 254 and address = lower(address)),
  status text not null default 'waiting' check (status in ('waiting', 'confirmed', 'declined')),
  first_seen_at timestamptz not null default now(),
  decided_by_email text,
  decided_at timestamptz,
  -- True while it waits with a receipt held that its organization's owners were not told of.
  untold boolean not null default false,
  unique (location_id, address)
);

comment on table public.receipt_senders is
  'The addresses that send receipts to a location''s receipt address, and whether an owner or admin confirmed each.';

create index receipt_senders_organization on public.receipt_senders (organization_id);
create index receipt_senders_untold on public.receipt_senders (id) where untold;

alter table public.receipt_senders enable row level security;
revoke all on public.receipt_senders from public, anon, authenticated;
grant select on public.receipt_senders to authenticated;
grant all on public.receipt_senders to service_role;

create policy "Members read their organization's receipt senders"
  on public.receipt_senders for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads receipt senders"
  on public.receipt_senders for select to authenticated
  using ((select public.is_operator()));

-- A customer's address and the day of their job, from one receipt. `held` until its sender is
-- confirmed, and then `ready`. The full address is in `address`, which no API role is granted;
-- `masked` is what everyone else reads.
create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  sender_id uuid not null references public.receipt_senders (id) on delete cascade,
  address text not null check (
    char_length(address) <= 254
    and address = lower(address)
    and address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- The first letter of the name and the domain, as maskAddress() in the shared package writes it.
  masked text generated always as (
    substr(address, 1, 1) || '•••@' || split_part(address, '@', 2)
  ) stored,
  job_day date not null,
  status text not null check (status in ('held', 'ready')),
  -- Generated for a test organization or a deployment on sample data, never received.
  sample_data boolean not null default false,
  received_at timestamptz not null default now(),
  -- The same customer copied twice for one day is one contact.
  unique (location_id, address, job_day)
);

comment on table public.customer_contacts is
  'A customer''s address and the day of their job, from a copied receipt. Only the worker reads the address in full.';

create index customer_contacts_organization on public.customer_contacts (organization_id);
create index customer_contacts_sender on public.customer_contacts (sender_id);
create index customer_contacts_held on public.customer_contacts (received_at) where status = 'held';

alter table public.customer_contacts enable row level security;
revoke all on public.customer_contacts from public, anon, authenticated;
-- Every column but the address.
grant select (
  id, organization_id, location_id, sender_id, masked, job_day, status, sample_data, received_at
) on public.customer_contacts to authenticated;
grant all on public.customer_contacts to service_role;

create policy "Members read their organization's customer contacts, masked"
  on public.customer_contacts for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads customer contacts, masked"
  on public.customer_contacts for select to authenticated
  using ((select public.is_operator()));

-- How many receipts were dropped for a location, by day and reason. Nothing else of them is kept.
create table public.receipt_drops (
  location_id uuid not null references public.locations (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day date not null,
  reason text not null check (reason in (
    'unauthenticated', 'not_on', 'declined_sender', 'no_customer', 'several_customers'
  )),
  count integer not null default 0 check (count >= 0),
  primary key (location_id, day, reason)
);

comment on table public.receipt_drops is
  'How many receipts copied to a location were dropped, by day and why. Nothing of them is kept.';

create index receipt_drops_organization on public.receipt_drops (organization_id);

alter table public.receipt_drops enable row level security;
revoke all on public.receipt_drops from public, anon, authenticated;
grant select on public.receipt_drops to authenticated;
grant all on public.receipt_drops to service_role;

create policy "Members read their organization's dropped receipts"
  on public.receipt_drops for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads dropped receipts"
  on public.receipt_drops for select to authenticated
  using ((select public.is_operator()));

-- Counts one receipt dropped for a location today (UTC), for the reason given. Worker only.
create function public.record_receipt_drop(location uuid, reason text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.receipt_drops (location_id, organization_id, day, reason, count)
  select l.id, l.organization_id, (now() at time zone 'utc')::date, reason, 1
  from public.locations l where l.id = location
  on conflict on constraint receipt_drops_pkey
  do update set count = public.receipt_drops.count + 1;
$$;

revoke execute on function public.record_receipt_drop(uuid, text) from public, anon, authenticated;
grant execute on function public.record_receipt_drop(uuid, text) to service_role;

-- Keeps what one receipt to a location's review requests said: its sender, its one customer and
-- the day of the job, which the worker read from it. Says what became of it:
--   `ready`, a contact from a confirmed sender;
--   `held`, a contact from a sender nobody has confirmed yet, who is then on file as waiting;
--   `declined_sender`, or `not_on` where the review requests are off, paused or being turned
--   off, each dropped and counted for the location;
--   `unknown`, where there are no such review requests or they have no location left.
-- The same customer copied twice for one day is kept once. Worker only.
create function public.receive_receipt(
  connection uuid,
  sender text,
  customer text,
  day date,
  sample boolean default false
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  s public.review_request_settings;
  from_sender public.receipt_senders;
  kept text;
begin
  select * into s from public.review_request_settings x where x.connection_id = connection;
  if not found or s.location_id is null then
    return 'unknown';
  end if;
  if s.released_at is not null or not exists (
    select 1 from public.connections c
    where c.id = connection and c.status not in ('paused', 'removing', 'removed')
  ) then
    perform public.record_receipt_drop(s.location_id, 'not_on');
    return 'not_on';
  end if;

  insert into public.receipt_senders (organization_id, location_id, address)
  values (s.organization_id, s.location_id, lower(sender))
  on conflict (location_id, address) do nothing;
  select * into from_sender from public.receipt_senders r
  where r.location_id = s.location_id and r.address = lower(sender);
  if from_sender.status = 'declined' then
    perform public.record_receipt_drop(s.location_id, 'declined_sender');
    return 'declined_sender';
  end if;

  kept := case from_sender.status when 'confirmed' then 'ready' else 'held' end;
  insert into public.customer_contacts
    (organization_id, location_id, sender_id, address, job_day, status, sample_data)
  values (s.organization_id, s.location_id, from_sender.id, lower(customer), day, kept, sample)
  on conflict (location_id, address, job_day) do nothing;
  if kept = 'held' then
    update public.receipt_senders set untold = true where id = from_sender.id;
  end if;
  return kept;
end;
$$;

revoke execute on function public.receive_receipt(uuid, text, text, date, boolean)
  from public, anon, authenticated;
grant execute on function public.receive_receipt(uuid, text, text, date, boolean) to service_role;

-- Confirms a waiting sender as the business's own tool: what it sent that was held is ready.
-- Answers only an owner or admin of the sender's organization, the operator not included, and
-- only for a sender still waiting: for anyone or anything else, no row.
create function public.confirm_receipt_sender(sender uuid)
returns setof public.receipt_senders
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  decided public.receipt_senders;
begin
  if not public.has_org_role(
    (select r.organization_id from public.receipt_senders r where r.id = sender),
    array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;
  update public.receipt_senders r
  set status = 'confirmed', untold = false, decided_at = now(),
    decided_by_email = (select u.email from auth.users u where u.id = caller)
  where r.id = sender and r.status = 'waiting'
  returning r.* into decided;
  if decided.id is null then
    return;
  end if;
  update public.customer_contacts set status = 'ready'
  where sender_id = sender and status = 'held';
  return next decided;
end;
$$;

revoke execute on function public.confirm_receipt_sender(uuid) from public, anon;
grant execute on function public.confirm_receipt_sender(uuid) to authenticated;

-- Declines a waiting sender: what it sent that was held is deleted, and what it sends from then
-- on is dropped and counted. Answers as confirm_receipt_sender() does.
create function public.decline_receipt_sender(sender uuid)
returns setof public.receipt_senders
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  decided public.receipt_senders;
begin
  if not public.has_org_role(
    (select r.organization_id from public.receipt_senders r where r.id = sender),
    array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;
  update public.receipt_senders r
  set status = 'declined', untold = false, decided_at = now(),
    decided_by_email = (select u.email from auth.users u where u.id = caller)
  where r.id = sender and r.status = 'waiting'
  returning r.* into decided;
  if decided.id is null then
    return;
  end if;
  delete from public.customer_contacts where sender_id = sender and status = 'held';
  return next decided;
end;
$$;

revoke execute on function public.decline_receipt_sender(uuid) from public, anon;
grant execute on function public.decline_receipt_sender(uuid) to authenticated;

-- Deletes every contact held seven days with nobody confirming its sender. Returns how many.
-- Worker only.
create function public.drop_expired_held_contacts()
returns integer
language sql security definer set search_path = ''
as $$
  with dropped as (
    delete from public.customer_contacts
    where status = 'held' and received_at < now() - interval '7 days'
    returning 1
  )
  select count(*)::integer from dropped;
$$;

revoke execute on function public.drop_expired_held_contacts() from public, anon, authenticated;
grant execute on function public.drop_expired_held_contacts() to service_role;
