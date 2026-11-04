-- Turning review requests on for a location (issue #290, part of #146,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md).
--
-- An owner or admin turns them on for one location, as a connection of the review_requests kind
-- matched to it at once and with no sign-in. Turning them on sets the location's receipt address,
-- an unguessable name at the product's receiving domain that its owner copies receipts to; the
-- site a customer is asked to review the business on; the address a customer's reply goes to; and
-- approves the wording, which is composed by rule and not kept, since nobody edits it. Who turned
-- them on, and when, is the connection's. Nothing is received or sent yet.
--
-- Turning them on is refused for a location with no time zone, since a request is sent at a time of
-- the location's day; for a category whose list of customers is confidential; without the owner's
-- word that their list is not confidential and their customers expect to hear from them; and for a
-- site where the location has no listing to ask for a review on. They are turned off as any
-- connection is removed, and the receipt address then belongs to nobody.
--
-- The Worker deployed before this migration keeps working. It calls create_connection() and
-- finish_connection_removal() with the arguments they had, which answer as before for every kind it
-- knows, and it reads no review requests. Its export schema leaves out the list it does not know.

insert into public.connection_kind_allowances (kind, allowance)
values ('review_requests', 'review_requests');

create table public.review_request_settings (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  -- The name in front of the receiving domain. Replacing it makes a new one, and the old one is
  -- nobody's from then on.
  receipt_address text not null unique check (receipt_address ~ '^[0-9a-f]{32}$'),
  address_made_at timestamptz not null default now(),
  -- The site asked for, as the list of known sites names it.
  site text not null check (site in ('google.com', 'bbb.org', 'trustpilot.com')),
  reply_to text not null check (
    char_length(reply_to) <= 254 and reply_to ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- When they were turned off and the receipt address let go.
  released_at timestamptz
);

comment on table public.review_request_settings is
  'A location''s review requests: its receipt address, the site asked for and where replies go.';

-- A location has review requests on once at a time.
create unique index review_request_settings_held on public.review_request_settings (location_id)
  where released_at is null;
create index review_request_settings_organization
  on public.review_request_settings (organization_id);

-- A member reads their location's review requests, and the operator reads every one. Nothing
-- writes one through the API except the functions below.
alter table public.review_request_settings enable row level security;
revoke all on public.review_request_settings from public, anon, authenticated;
grant select on public.review_request_settings to authenticated;
grant all on public.review_request_settings to service_role;

create policy "Members read their organization's review requests"
  on public.review_request_settings for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads review requests"
  on public.review_request_settings for select to authenticated
  using ((select public.is_operator()));

-- Whether a location's category says its list of customers is confidential: medical, dental,
-- mental health, legal, financial advice and the like, by a whole word or two of the list, in any
-- case and as a plural. The shared package holds the same list in CONFIDENTIAL_KINDS, and a test
-- holds the two together.
create function public.is_confidential_category(category text)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(category ~* ('\m(' || array_to_string(array[
    'medical', 'medicine', 'doctor', 'physician', 'clinic', 'hospital', 'health care',
    'healthcare', 'urgent care', 'nurse', 'nursing', 'pharmacy', 'pharmacist', 'surgeon',
    'surgery', 'pediatrician', 'pediatric', 'dermatologist', 'cardiologist', 'gynecologist',
    'obstetrician', 'fertility', 'optometrist', 'ophthalmologist', 'chiropractor',
    'chiropractic', 'physiotherapist', 'physiotherapy', 'physical therapist', 'physical therapy',
    'dentist', 'dental', 'orthodontist', 'orthodontic', 'endodontist', 'periodontist',
    'mental health', 'therapist', 'therapy', 'psychotherapist', 'psychotherapy', 'psychiatrist',
    'psychiatric', 'psychologist', 'psychology', 'counselor', 'counsellor', 'counseling',
    'counselling', 'rehab', 'rehabilitation', 'addiction',
    'legal', 'lawyer', 'attorney', 'law firm', 'law office', 'solicitor',
    'financial advisor', 'financial adviser', 'financial advisory', 'financial planner',
    'financial planning', 'wealth management', 'investment advisor', 'investment adviser',
    'accountant', 'accounting', 'tax preparation'
  ], '|') || ')s?\M'), false);
$$;

-- A new receipt address: 122 random bits, which nobody can guess or work out from another.
create function public.new_receipt_address()
returns text
language sql volatile set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '');
$$;

revoke execute on function public.new_receipt_address() from public, anon, authenticated;

-- Turns a location's review requests on: a new connection of the review_requests kind matched to
-- the location, with no sign-in, and its settings, with a new receipt address. Calling it is the
-- caller's approval of the wording and their word, as `confirmed`, that the list of customers is
-- not confidential and the customers expect to hear from the business. Answers only an owner or
-- admin of the location's organization: for anyone else, no row. Refuses, with the reason, a plan
-- without review requests, a location that has them on already, has no time zone or whose
-- category is a confidential one, a call without the confirmation, a site where the location has
-- no listing with a review form, and a reply address that is not one.
create function public.turn_on_review_requests(
  location uuid,
  new_id uuid,
  chosen_site text,
  reply_address text,
  confirmed boolean
)
returns setof public.connections
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  l public.locations;
  reply text := lower(btrim(coalesce(reply_address, '')));
begin
  select * into l from public.locations x where x.id = location;
  if not found
    or not public.has_org_role(l.organization_id, array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;
  if not public.allows_connection(l.organization_id, 'review_requests') then
    raise exception 'This organization''s plan does not include review requests.'
      using errcode = 'NC017';
  end if;
  if exists (
    select 1 from public.review_request_settings s
    where s.location_id = location and s.released_at is null
  ) then
    raise exception 'Review requests are on for this location already.' using errcode = 'NC017';
  end if;
  if l.time_zone is null then
    raise exception 'Set this location''s time zone under Settings first.' using errcode = 'NC017';
  end if;
  if public.is_confidential_category(l.primary_category) then
    raise exception 'Review requests are not offered to a business whose list of customers is confidential, such as a clinic or a law firm.'
      using errcode = 'NC017';
  end if;
  if confirmed is not true then
    raise exception 'Confirm that your customer list is not confidential, and that your customers expect to hear from you.'
      using errcode = 'NC017';
  end if;
  -- A listing with a review form: on Google the review link itself, and on BBB and Trustpilot a
  -- listing whose address the form is made from, as reviewForm() in the shared package reads it.
  if chosen_site is null or not exists (
    select 1 from public.listings g
    where g.location_id = location and g.site = chosen_site
      and case chosen_site
        when 'google.com' then true
        when 'bbb.org' then
          g.url ~ '^https://([a-z0-9-]+\.)*bbb\.org/us/[a-z]{2}/[^/?#]+/profile/[^/?#]+/[^/?#]+'
        when 'trustpilot.com' then
          g.url ~ '^https://([a-z0-9-]+\.)*trustpilot\.com/(review|evaluate)/[^/?#]+/?([?#].*)?$'
        else false
      end
  )
  then
    raise exception 'Choose a site where this location has a listing to be reviewed on.'
      using errcode = 'NC017';
  end if;
  if char_length(reply) > 254 or reply !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter the email address a customer''s reply goes to.' using errcode = 'NC017';
  end if;

  insert into public.connections (
    id, organization_id, kind, label, connected_by, connected_by_email, choices, last_synced_at
  )
  values (
    new_id,
    l.organization_id,
    'review_requests',
    l.name,
    caller,
    (select u.email from auth.users u where u.id = caller),
    jsonb_build_array(jsonb_build_object('id', location::text, 'label', l.name)),
    now()
  );
  insert into public.connection_locations
    (connection_id, kind, location_id, external_id, external_label)
  values (new_id, 'review_requests', location, location::text, l.name);
  insert into public.review_request_settings
    (connection_id, organization_id, location_id, receipt_address, site, reply_to)
  values (new_id, l.organization_id, location, public.new_receipt_address(), chosen_site, reply);

  return query select * from public.connections c where c.id = new_id;
end;
$$;

revoke execute on function public.turn_on_review_requests(uuid, uuid, text, text, boolean)
  from public, anon;
grant execute on function public.turn_on_review_requests(uuid, uuid, text, text, boolean)
  to authenticated;

-- Gives a location's review requests a new receipt address. The old one belongs to nobody from
-- then on, so a receipt copied to it reaches nothing; what came through it before stays. Answers
-- only an owner or admin of the location's organization, and only while the requests are not
-- being turned off: for anyone or anything else, no row.
create function public.replace_receipt_address(location uuid)
returns setof public.review_request_settings
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_org_role(
    (select l.organization_id from public.locations l where l.id = location),
    array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;

  return query
  update public.review_request_settings s
  set receipt_address = public.new_receipt_address(), address_made_at = now()
  from public.connections c
  where c.id = s.connection_id
    and s.location_id = location
    and s.released_at is null
    and c.status not in ('removing', 'removed')
  returning s.*;
end;
$$;

revoke execute on function public.replace_receipt_address(uuid) from public, anon;
grant execute on function public.replace_receipt_address(uuid) to authenticated;

-- Review requests are now refused here too: they are turned on with turn_on_review_requests().
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
  if of_kind = 'review_requests' then
    raise exception 'Review requests are turned on with turn_on_review_requests().'
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

-- Finishing a removal now also lets review requests' receipt address go. Otherwise as before.
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
  update public.review_request_settings set released_at = now()
  where connection_id = connection and released_at is null;
  return true;
end;
$$;

-- A location's review requests are turned off with the location: there is nobody left to ask for.
-- The worker finishes it as any removal.
create function public.remove_review_requests_of_location()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.connections c
  set status = 'removing', removal_reason = 'location', removal_requested_at = now()
  from public.review_request_settings s
  where s.connection_id = c.id
    and s.location_id = old.id
    and c.status not in ('removing', 'removed');
  return old;
end;
$$;

revoke execute on function public.remove_review_requests_of_location()
  from public, anon, authenticated;

create trigger remove_review_requests_of_location
  before delete on public.locations
  for each row execute function public.remove_review_requests_of_location();

-- export_organization() carries each location's review requests: the receipt address, the site
-- asked for and where replies go, and when they were turned off. Otherwise as before.
create or replace function public.export_organization(org uuid)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'exported_at', now(),
    'organization', (
      select to_jsonb(r) from (
        select id, name, max_locations, max_queries_per_location, max_manual_scans_per_month,
          scan_every_days, surfaces, stronger_surfaces, is_test, emails_report, allowances,
          plan_key, created_at
        from public.organizations where id = o.id
      ) r
    ),
    'subscription_status', (
      select s.status from public.subscriptions s where s.organization_id = o.id
    ),
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object('email', u.email, 'role', m.role, 'joined_at', m.created_at)
        order by m.created_at, m.role, u.email
      )
      from public.memberships m
      left join auth.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'),
    'locations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select id, organization_id, name, website, phone, address_line, city, region,
          postal_code, country_code, google_place_id, latitude, longitude, point_source,
          geocoded_from, primary_category, what_we_do, time_zone, paused_by_plan, last_scanned_at,
          created_at
        from public.locations where organization_id = o.id
      ) r
    ), '[]'),
    'prompts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select q.id, q.location_id, q.kind, q.text, q.is_active, q.set_aside_by_plan, q.created_at
        from public.tracked_queries q
        join public.locations l on l.id = q.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'scans', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select s.id, s.location_id, s.status, s.trigger, s.visibility_score, s.error,
          s.sample_data, s.tiers, s.created_at, s.started_at, s.finished_at
        from public.scans s
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'answers', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sampled_at, r.id) from (
        select x.id, x.scan_id, x.tracked_query_id, x.surface, x.shown, x.mentioned, x.position,
          x.competitors, x.cited_urls, x.answer_excerpt, x.phones, x.tier, x.sampled_at
        from public.scan_results x
        join public.scans s on s.id = x.scan_id
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select t.id, t.location_id, t.scan_id, t.rule, t.title, t.detail, t.status, t.acted_at,
          t.acted_by_action, t.created_at
        from public.recommendations t
        join public.locations l on l.id = t.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.raised_at, r.id) from (
        select a.id, a.location_id, a.kind, a.tracked_query_id, a.surface, a.tier, a.facts, a.since,
          a.scan_id, a.raised_at, a.cleared_at, a.clear_reason, a.dismissed_at,
          a.dismissed_by_email
        from public.alerts a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'drafts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.asked_at, r.id) from (
        select d.id, d.location_id, d.recommendation_id, d.status, d.asked_by_email, d.asked_at,
          d.failure, d.kind, d.text, d.written_at, d.sample_data
        from public.drafts d
        join public.locations l on l.id = d.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'actions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.proposed_at, r.id) from (
        select a.id, a.location_id, a.kind, a.connection_id, a.summary, a.seen,
          a.seen_dropped_at, a.proposed_text, a.written_by, a.status, a.proposed_at, a.lapses_at,
          a.approved_by_email, a.approved_at, a.approved_text, a.declined_by_email,
          a.declined_at, a.decline_reason, a.done_at, a.failed_at, a.failure, a.lapsed_at,
          a.lapse_reason, a.retry_of, a.takes_back, a.approved_under, a.approved_under_by_email,
          a.approved_under_at, a.always_asks
        from public.actions a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'standing_permissions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.given_at, r.id) from (
        select s.id, s.kind, s.given_by_email, s.given_at, s.ended_at, s.ended_by_email,
          s.end_reason, s.ended_by_action
        from public.standing_permissions s where s.organization_id = o.id
      ) r
    ), '[]'),
    'invitations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select i.id, i.organization_id, i.email, i.role, i.invited_by_email, i.created_at,
          i.sent_at, i.expires_at, i.ended_at, i.outcome
        from public.invitations i where i.organization_id = o.id
      ) r
    ), '[]'),
    'connections', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.connected_at, r.id) from (
        select c.id, c.organization_id, c.kind, c.label, c.status, c.connected_by_email,
          c.connected_at, c.removed_by_email, c.removal_requested_at, c.removed_at,
          c.broken_reason, c.broken_at, c.paused_at, c.removal_reason, c.last_synced_at,
          c.choices,
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'location_id', cl.location_id, 'external_id', cl.external_id,
                'external_label', cl.external_label, 'matched_at', cl.matched_at
              )
              order by cl.matched_at, cl.location_id
            )
            from public.connection_locations cl where cl.connection_id = c.id
          ), '[]') as matches
        from public.connections c where c.organization_id = o.id
      ) r
    ), '[]'),
    'listings', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.site) from (
        select g.location_id, g.site, g.url, g.set_by_email, g.set_at
        from public.listings g
        join public.locations l on l.id = g.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_addresses', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.recommendation_id) from (
        select p.location_id, p.recommendation_id, p.url, p.set_by_email, p.set_at, p.action_id
        from public.prompt_pages p
        join public.locations l on l.id = p.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.assistant, r.path) from (
        select v.location_id, v.day, v.assistant, v.path, v.count
        from public.visits v
        join public.locations l on l.id = v.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'hosted_pages', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.published_at, r.id) from (
        select h.id, h.location_id, n.hostname, h.slug, h.title, h.copy, h.published_at,
          h.taken_back_at
        from public.hosted_pages h
        join public.locations l on l.id = h.location_id
        left join public.answer_subdomains n on n.connection_id = h.connection_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_fetches', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.hosted_page_id, r.fetcher) from (
        select f.hosted_page_id, f.location_id, f.day, f.fetcher, f.count
        from public.hosted_page_fetches f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'site_fetches', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.fetcher, r.path) from (
        select f.location_id, f.day, f.fetcher, f.path, f.count, f.sample_data
        from public.site_fetches f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'analytics_visits', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.assistant, r.path) from (
        select a.location_id, a.day, a.assistant, a.path, a.count, a.sample_data
        from public.analytics_visits a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    -- The receipt address is written out whole, at the domain the shared package names in
    -- RECEIPTS_DOMAIN.
    'review_requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.address_made_at, r.connection_id) from (
        select s.connection_id, s.location_id,
          s.receipt_address || '@receipts.nearcited.com' as receipt_address,
          s.address_made_at, s.site, s.reply_to, s.released_at
        from public.review_request_settings s
        where s.organization_id = o.id
      ) r
    ), '[]')
  )
  from public.organizations o
  where o.id = org
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;
