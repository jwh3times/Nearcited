-- Review requests as actions (issue #292, part of #146,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md).
--
-- A customer contact becomes one action that a member approves, or standing permission approves
-- as it is made. It is sent at 10:00 in the location's time zone the morning after the job, or at
-- the next 10:00 when it is approved later, and it lapses unsent if nobody approves it within seven
-- days of the job. An address the organization asked within twelve months, or that opted out of
-- it, gets no proposal. Once the month's allowance is spoken for, a contact is not asked, is counted
-- for its location, and is deleted.
--
-- The Worker deployed before this migration goes on working. The columns added to `actions` are
-- read by name only by the Worker that comes with it, and nothing proposes the new kind until then.

-- The kind's terms: it takes from the review requests allowance, and what it replaced is nothing.
-- A request that was sent cannot be taken back, so no take-back is offered for it.
alter table public.action_kind_terms
  add column can_take_back boolean not null default true;

insert into public.action_kind_terms (kind, allowance, keeps_seen_days, can_take_back)
values ('review_request', 'review_requests', null, false);

alter table public.actions
  -- The customer contact a review request asks. Cleared when the contact is deleted.
  add column contact_id uuid references public.customer_contacts (id) on delete set null,
  -- The earliest it may be carried out, for a kind sent at a set time of day. Null for the rest,
  -- which are carried out as soon as they are approved.
  add column not_before timestamptz,
  -- When it is next due, once approved: `not_before`, or, approved after that, the next time the
  -- location's clock shows the same time of day. Kept by the trigger below.
  add column due_at timestamptz;

create index actions_contact on public.actions (contact_id) where contact_id is not null;

-- The first moment at or after `from` at which the location's clock shows the time of day
-- `not_before` shows. For the trigger below.
create function public.next_same_time(not_before timestamptz, from_at timestamptz, zone text)
returns timestamptz
language plpgsql immutable set search_path = ''
as $$
declare
  local_from timestamp := from_at at time zone zone;
  candidate timestamp;
begin
  if from_at <= not_before then
    return not_before;
  end if;
  candidate := local_from::date + (not_before at time zone zone)::time;
  if candidate < local_from then
    candidate := candidate + interval '1 day';
  end if;
  return candidate at time zone zone;
end;
$$;

revoke execute on function public.next_same_time(timestamptz, timestamptz, text)
  from public, anon, authenticated;

-- Keeps `due_at`: set while an action with a set time is approved, from when it was approved, and
-- null otherwise.
create function public.set_action_due_at()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.not_before is null or new.status <> 'approved' or new.approved_at is null then
    new.due_at := null;
  else
    new.due_at := public.next_same_time(
      new.not_before,
      new.approved_at,
      coalesce((select l.time_zone from public.locations l where l.id = new.location_id), 'UTC')
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.set_action_due_at() from public, anon, authenticated;

create trigger set_action_due_at
  before insert or update of status, approved_at, not_before on public.actions
  for each row execute function public.set_action_due_at();

-- Whom an organization has asked for a review, as a keyed fingerprint of the address that cannot
-- be read back, and when it last did: an address asked within twelve months is not asked again by
-- any of the organization's locations. Kept when the contact is deleted. No API role reads it, the
-- operator included: it answers only the worker's "asked before?".
create table public.asked_addresses (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) between 1 and 128),
  asked_at timestamptz not null default now(),
  -- The request that last asked it.
  action_id uuid references public.actions (id) on delete set null,
  primary key (organization_id, fingerprint)
);

comment on table public.asked_addresses is
  'The keyed fingerprints of the addresses an organization asked for a review, and when. Worker only.';

alter table public.asked_addresses enable row level security;
revoke all on public.asked_addresses from public, anon, authenticated;
grant all on public.asked_addresses to service_role;

-- The addresses that opted out of an organization's review requests, as keyed fingerprints. None
-- of its locations asks one again. Written by the opt-out the next change adds; no API role reads
-- it, the operator included.
create table public.opted_out_addresses (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) between 1 and 128),
  opted_out_at timestamptz not null default now(),
  primary key (organization_id, fingerprint)
);

comment on table public.opted_out_addresses is
  'The keyed fingerprints of the addresses that opted out of an organization''s review requests. Worker only.';

alter table public.opted_out_addresses enable row level security;
revoke all on public.opted_out_addresses from public, anon, authenticated;
grant all on public.opted_out_addresses to service_role;

-- Records that a review request asked its address, by the address's keyed fingerprint, once the
-- email went. Worker only.
create function public.mark_asked(action uuid, fingerprint text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.asked_addresses (organization_id, fingerprint, asked_at, action_id)
  select l.organization_id, fingerprint, now(), a.id
  from public.actions a
  join public.locations l on l.id = a.location_id
  where a.id = action
  on conflict (organization_id, fingerprint)
  do update set asked_at = excluded.asked_at, action_id = excluded.action_id;
$$;

revoke execute on function public.mark_asked(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_asked(uuid, text) to service_role;

-- A contact not asked because the month's allowance was spoken for is counted with the receipts
-- dropped for its location.
alter table public.receipt_drops drop constraint receipt_drops_reason_check;
alter table public.receipt_drops add constraint receipt_drops_reason_check check (reason in (
  'unauthenticated', 'not_on', 'declined_sender', 'no_customer', 'several_customers',
  'allowance_used'
));

-- The ready customer contacts no review request was proposed for yet, where the plan includes
-- review requests and the location's are on, with the full address the worker fingerprints. The
-- oldest first, at most 500: the schedule reads it again at its next run. Not for an organization
-- being closed. Worker only.
create function public.contacts_to_ask()
returns table (
  id uuid,
  organization_id uuid,
  location_id uuid,
  address text,
  masked text,
  job_day date
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.organization_id, c.location_id, c.address, c.masked, c.job_day
  from public.customer_contacts c
  join public.organizations o on o.id = c.organization_id
  join public.review_request_settings s
    on s.location_id = c.location_id and s.released_at is null
  join public.connections x on x.id = s.connection_id and x.status = 'working'
  where c.status = 'ready'
    and o.allowances ? 'review_requests'
    and o.closing_at is null
    and not exists (select 1 from public.actions a where a.contact_id = c.id)
  order by c.received_at, c.id
  limit 500;
$$;

revoke execute on function public.contacts_to_ask() from public, anon, authenticated;
grant execute on function public.contacts_to_ask() to service_role;

-- Proposes asking one ready customer contact for a review, as the worker composed it: `fingerprint`
-- is the keyed fingerprint of the address, `what` the sentence it is shown as and `wording` the
-- email as the owner approved it. Says what became of it:
--   `proposed`, or `approved` where standing permission approved it as it was made;
--   `already_proposed`, where the contact already has its action;
--   `not_ready`, where there is no such contact or its sender is not confirmed, `not_included`,
--   where the plan does not include review requests, and `not_on`, where the location's are off:
--   each keeps the contact;
--   `allowance_used`, where the month's allowance is spoken for: counted for the location;
--   `too_late`, where the week after the job is over, `opted_out`, where the address opted out of
--   the organization, and `asked_before`, where the organization asked it within twelve months:
--   each deletes the contact.
-- Worker only.
create function public.propose_review_request(
  contact uuid,
  fingerprint text,
  what text,
  wording text
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  c public.customer_contacts;
  s public.review_request_settings;
  zone text;
  allowance jsonb;
  locations integer;
  spoken_for integer;
  made public.actions;
begin
  select * into c from public.customer_contacts x where x.id = contact for update;
  if not found or c.status <> 'ready' then
    return 'not_ready';
  end if;
  if exists (select 1 from public.actions a where a.contact_id = contact) then
    return 'already_proposed';
  end if;
  select o.allowances -> 'review_requests', o.max_locations into allowance, locations
  from public.organizations o where o.id = c.organization_id;
  if allowance is null then
    return 'not_included';
  end if;
  select * into s from public.review_request_settings x
  where x.location_id = c.location_id and x.released_at is null;
  if not found or not exists (
    select 1 from public.connections x where x.id = s.connection_id and x.status = 'working'
  ) then
    return 'not_on';
  end if;
  select coalesce(l.time_zone, 'UTC') into zone from public.locations l where l.id = c.location_id;

  -- Nobody is asked once the week after the job is over, and nothing of them is kept.
  if ((c.job_day + 7) + time '10:00') at time zone zone <= now() then
    delete from public.customer_contacts where id = contact;
    return 'too_late';
  end if;

  -- Nobody the organization asked within twelve months, or who opted out of it, is asked, and
  -- nothing of them is kept.
  if exists (
    select 1 from public.opted_out_addresses o
    where o.organization_id = c.organization_id and o.fingerprint = propose_review_request.fingerprint
  ) then
    delete from public.customer_contacts where id = contact;
    return 'opted_out';
  end if;
  if exists (
    select 1 from public.asked_addresses o
    where o.organization_id = c.organization_id and o.fingerprint = propose_review_request.fingerprint
      and o.asked_at > now() - interval '12 months'
  ) then
    delete from public.customer_contacts where id = contact;
    return 'asked_before';
  end if;

  -- Once what the month allows is spoken for, by what was taken from it and by what is waiting or
  -- on its way, nobody more is asked: each is counted for the location, and nothing of them kept.
  if allowance <> 'true'::jsonb then
    select coalesce(sum(u.used), 0)::integer into spoken_for
    from public.allowance_use u
    where u.organization_id = c.organization_id and u.kind = 'review_requests'
      and u.month = date_trunc('month', now() at time zone 'UTC')::date;
    select spoken_for + count(*)::integer into spoken_for
    from public.actions a
    join public.locations l on l.id = a.location_id
    where l.organization_id = c.organization_id and a.kind = 'review_request'
      and a.status in ('proposed', 'approved') and a.allowance_month is null;
    if spoken_for >= (allowance #>> '{}')::integer * locations then
      perform public.record_receipt_drop(c.location_id, 'allowance_used');
      delete from public.customer_contacts where id = contact;
      return 'allowance_used';
    end if;
  end if;

  select * into made from public.propose_action(
    c.location_id, 'review_request', s.connection_id, 'contact:' || contact, wording, what,
    jsonb_build_object('text', null), wording, 'rule'
  );
  if made.id is null then
    return 'not_proposed';
  end if;
  update public.actions
  set contact_id = contact,
      not_before = ((c.job_day + 1) + time '10:00') at time zone zone,
      lapses_at = ((c.job_day + 7) + time '10:00') at time zone zone
  where id = made.id
  returning * into made;
  return made.status::text;
end;
$$;

revoke execute on function public.propose_review_request(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.propose_review_request(uuid, text, text, text) to service_role;

-- The worker takes an approved action to carry out, as before, and now not before it is due.
create or replace function public.claim_action(action uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
  org uuid;
  terms public.action_kind_terms;
  claim record;
  took date;
  try integer;
begin
  select * into a from public.actions where id = action for update;
  if not found or a.status <> 'approved'
    or (a.carrying_since is not null and a.carrying_since >= now() - interval '10 minutes')
    or a.due_at > now()
  then
    return 0;
  end if;
  select l.organization_id into org from public.locations l where l.id = a.location_id;
  if public.organization_held(org) then
    return 0;
  end if;

  if a.approved_under is not null and (
    a.always_asks
    or not exists (
      select 1 from public.standing_permissions s
      join public.organizations o on o.id = s.organization_id
      where s.id = a.approved_under and s.ended_at is null
        and o.allowances ? 'standing_permission'
    )
  ) then
    perform public.return_to_waiting(action);
    return 0;
  end if;

  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and a.allowance_month is null then
    select * into claim from public.claim_allowance(org, terms.allowance);
    if not coalesce(claim.claimed, false) then
      update public.actions
      set status = 'failed', failed_at = now(), carrying_since = null,
          failure = 'Your plan has no more of these this month.'
      where id = action;
      return 0;
    end if;
    -- A kind included without a number counts nothing, so there is nothing to give back.
    if claim.allowed is not null then
      took := date_trunc('month', now() at time zone 'UTC')::date;
    end if;
  end if;

  update public.actions
  set carrying_since = now(), attempts = attempts + 1,
      allowance_month = coalesce(took, allowance_month)
  where id = action
  returning attempts into try;
  return try;
end;
$$;

-- Taking back, as before, and now refused for a kind that cannot be taken back: a review request
-- that was sent.
create or replace function public.take_back_action(action uuid)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'done' then
    raise exception 'Only something that was done can be taken back.' using errcode = 'NC013';
  end if;
  if not (select t.can_take_back from public.action_kind_terms t where t.kind = a.kind) then
    raise exception 'This cannot be taken back once it was done.' using errcode = 'NC013';
  end if;
  if a.seen_dropped_at is not null then
    raise exception 'What it replaced is no longer kept, so it cannot be put back.'
      using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status in ('proposed', 'approved')
  ) then
    raise exception 'There is already one of these waiting or on its way.' using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status = 'done' and o.done_at > a.done_at
  ) then
    raise exception 'Something done since has changed this. Take that back instead.'
      using errcode = 'NC013';
  end if;

  if a.approved_under is not null then
    perform public.end_permission(a.approved_under, 'taken_back', caller, a.id);
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, takes_back)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, 'take-back:' || a.id,
       left('Take back: ' || a.summary, 300),
       jsonb_build_object('text', coalesce(a.approved_text, a.proposed_text)),
       a.seen ->> 'text', 'rule', 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.id)
    returning *;
end;
$$;

-- Asking again, as before, and now keeping the time a request goes at and the week it may go in:
-- one whose week is over is not asked for again.
create or replace function public.retry_action(action uuid)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
  terms public.action_kind_terms;
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'failed' then
    raise exception 'Only an action that failed can be asked for again.' using errcode = 'NC013';
  end if;
  if a.not_before is not null and a.lapses_at <= now() then
    raise exception 'This is not asked for again: the week after the job is over.'
      using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status in ('proposed', 'approved')
  ) then
    raise exception 'There is already one of these waiting or on its way.' using errcode = 'NC013';
  end if;
  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and not coalesce(public.allowance_has_room(
    (select l.organization_id from public.locations l where l.id = a.location_id),
    terms.allowance), false)
  then
    raise exception 'Your plan has no more of these this month.' using errcode = 'NC013';
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, approved_text, retry_of,
       recommendation_id, seen_until, seen_dropped_at, contact_id, not_before, lapses_at)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, a.basis, a.summary, a.seen,
       a.proposed_text, a.written_by, 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.approved_text, a.id,
       a.recommendation_id, a.seen_until, a.seen_dropped_at, a.contact_id, a.not_before,
       case when a.not_before is null then now() + interval '14 days' else a.lapses_at end)
    returning *;
end;
$$;

-- Putting back to waiting, as before, except that one with a set time keeps the week it may go in.
create or replace function public.return_to_waiting(action uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
begin
  select * into a from public.actions
  where id = action and status = 'approved' and approved_under is not null
    and (carrying_since is null or carrying_since < now() - interval '10 minutes')
  for update;
  if not found then
    return false;
  end if;

  update public.actions
  set status = 'proposed', approved_at = null, approved_under = null,
      approved_under_by_email = null, approved_under_at = null,
      lapses_at = case when a.not_before is null then now() + interval '14 days' else a.lapses_at end,
      waiting_told_at = null,
      attempts = 0, carrying_since = null, failure = null, allowance_month = null
  where id = action;

  if a.allowance_month is not null then
    perform public.release_allowance(
      (select l.organization_id from public.locations l where l.id = a.location_id),
      (select t.allowance from public.action_kind_terms t where t.kind = a.kind),
      a.allowance_month
    );
  end if;
  return true;
end;
$$;
