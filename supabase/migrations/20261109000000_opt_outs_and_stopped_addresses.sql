-- A customer opts out of an organization's review requests, and an address that bounced hard or
-- complained is never written to again (issue #293, part of #146). Both arrive with no signed-in
-- user: the routes check the link's signature or the provider's, put a message on the queue and do
-- nothing else, and the worker records them here. Both are kept only as the keyed fingerprint of
-- the address (the same one `asked_addresses` keeps), never the address.
--
-- The Worker deployed before this migration is not touched by it: it writes neither, and
-- `stopped_addresses` is empty until the next one does, so the new `stopped` outcome never reaches
-- it.

-- The addresses that bounced hard or complained about a review request, as keyed fingerprints. No
-- organization asks one again. No API role reads it, the operator included.
create table public.stopped_addresses (
  fingerprint text primary key check (char_length(fingerprint) between 1 and 128),
  reason text not null check (reason in ('bounce', 'complaint')),
  stopped_at timestamptz not null default now()
);

comment on table public.stopped_addresses is
  'The keyed fingerprints of the addresses that bounced hard or complained about a review request. Worker only.';

alter table public.stopped_addresses enable row level security;
revoke all on public.stopped_addresses from public, anon, authenticated;
grant all on public.stopped_addresses to service_role;

-- Records that an address opted out of an organization's review requests, by its keyed
-- fingerprint, from a link to opt out or the one-click unsubscribe. Nothing for an organization
-- that is not there, since a link outlives its organization. Worker only.
create function public.opt_out_address(org uuid, fingerprint text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.opted_out_addresses (organization_id, fingerprint)
  select o.id, opt_out_address.fingerprint from public.organizations o where o.id = org
  on conflict (organization_id, fingerprint) do nothing;
$$;

revoke execute on function public.opt_out_address(uuid, text) from public, anon, authenticated;
grant execute on function public.opt_out_address(uuid, text) to service_role;

-- Records that an address bounced hard or complained, by its keyed fingerprint, from a report the
-- email provider signed. The first reason is kept. Worker only.
create function public.stop_address(fingerprint text, reason text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.stopped_addresses (fingerprint, reason)
  values (stop_address.fingerprint, stop_address.reason)
  on conflict on constraint stopped_addresses_pkey do nothing;
$$;

revoke execute on function public.stop_address(text, text) from public, anon, authenticated;
grant execute on function public.stop_address(text, text) to service_role;

-- As before, and `opted_out` now says the organization may not ask the address: it opted out of
-- this organization, or it bounced hard or complained, which counts for every organization.
-- Worker only.
create or replace function public.asking_record(org uuid, fingerprint text)
returns table (asked_by uuid, asked_recently boolean, opted_out boolean)
language sql stable security definer set search_path = ''
as $$
  select
    (select a.action_id from public.asked_addresses a
     where a.organization_id = org and a.fingerprint = asking_record.fingerprint),
    exists (
      select 1 from public.asked_addresses a
      where a.organization_id = org and a.fingerprint = asking_record.fingerprint
        and a.asked_at > now() - interval '12 months'
    ),
    exists (
      select 1 from public.opted_out_addresses o
      where o.organization_id = org and o.fingerprint = asking_record.fingerprint
    ) or exists (
      select 1 from public.stopped_addresses s where s.fingerprint = asking_record.fingerprint
    );
$$;

-- As before, and an address that bounced hard or complained is asked by no organization.
-- Proposes asking one ready customer contact for a review, as the worker composed it: `fingerprint`
-- is the keyed fingerprint of the address, `what` the sentence it is shown as and `wording` the
-- email as the owner approved it, null where the location has no review form left on the site
-- chosen. Says what became of it:
--   `proposed`, or `approved` where standing permission approved it as it was made;
--   `already_proposed`, where the contact already has its action;
--   `not_ready`, where there is no such contact or its sender is not confirmed, `not_included`,
--   where the plan does not include review requests, and `not_on`, where the location's are off:
--   each keeps the contact;
--   `allowance_used`, where the month's allowance is spoken for: counted for the location;
--   `too_late`, where the week after the job is over, `opted_out`, where the address opted out of
--   the organization, and `asked_before`, where the organization asked it within twelve months:
--   each deletes the contact;
--   `no_wording`, where there is no wording to send: the contact waits, until its week is over.
--   `stopped`, where the address bounced hard or complained about a review request: deletes the
--   contact.
-- Worker only.
create or replace function public.propose_review_request(
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

  -- Nobody whose address bounced hard or complained is asked by any organization again, and
  -- nothing of them is kept.
  if exists (
    select 1 from public.stopped_addresses stopped
    where stopped.fingerprint = propose_review_request.fingerprint
  ) then
    delete from public.customer_contacts where id = contact;
    return 'stopped';
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
      and a.allowance_month is null
      and (a.status = 'approved' or (a.status = 'proposed' and a.lapses_at > now()));
    if spoken_for >= (allowance #>> '{}')::integer * locations then
      perform public.record_receipt_drop(c.location_id, 'allowance_used');
      delete from public.customer_contacts where id = contact;
      return 'allowance_used';
    end if;
  end if;

  if wording is null then
    return 'no_wording';
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
