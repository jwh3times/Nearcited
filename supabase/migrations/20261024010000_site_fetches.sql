-- Fetches of a business's own site, read from its Cloudflare zone (issue #156,
-- docs/adr/0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md).
--
-- An assistant's fetcher reads a page without running its scripts, so the line on the site never
-- sees it. Where the site is served through Cloudflare, its owner connects a token that reads the
-- zone's request counts. Each sync lists the zones the token reaches, and the worker matches each
-- to the location whose website it holds: one zone, one location, the one made first where
-- several share the website. Then it reads, for each match, how many requests each known fetcher
-- made for each page of that website's host, by day, and keeps those counts.
--
-- What is kept is a count for a day, a location, a fetcher and a page, and nothing per request: no
-- time of day, address, query or user agent. A day read again is replaced, never added to. The
-- number of pages kept for a location on a day is bounded here, as visits' are, and the counts
-- are kept as long as the location is. Anyone can give a fetcher's name, so nothing is worked out
-- from them: no score, alert, task, report or bill.
--
-- The Worker deployed before this migration keeps working. It never offers a Cloudflare
-- connection, so none is synced by it, and every function it calls answers as before:
-- match_connection_location() only refuses a kind it does not know, and export_organization()
-- gains a list its schema leaves out.

insert into public.connection_kind_allowances (kind, allowance) values ('cloudflare', 'fetches');

-- The last day (UTC) a zone was read through for the location it is matched to. Only a Cloudflare
-- match has one, written by record_site_fetches(). A match made again starts with none, so its
-- first read takes the thirty days before.
alter table public.connection_locations add column read_through date;

comment on column public.connection_locations.read_through is
  'For a Cloudflare zone, the last day its fetches were read through for this location. Written only by record_site_fetches().';

create table public.site_fetches (
  location_id uuid not null references public.locations (id) on delete cascade,
  day date not null,
  -- The keys of PAGE_FETCHERS (packages/shared/src/hosted-pages.ts), as hosted_page_fetches names
  -- them: one list of fetchers for hosted pages and the own site.
  fetcher text not null check (fetcher in (
    'gptbot', 'oai-searchbot', 'chatgpt-user',
    'claudebot', 'claude-searchbot', 'claude-user',
    'perplexitybot', 'perplexity-user',
    'googlebot', 'bingbot'
  )),
  -- The page fetched, from its first slash, without a query. Empty for the fetches of every page
  -- past the fiftieth of a day, which are counted together.
  path text not null check (path = '' or (path like '/%' and char_length(path) <= 200)),
  -- Cloudflare's estimate, rounded: its figures are sampled on a busy zone.
  count integer not null check (count > 0),
  -- Made up for a test organization or a deployment on sample data. Nothing was fetched.
  sample_data boolean not null default false,
  primary key (location_id, day, fetcher, path)
);

comment on table public.site_fetches is
  'How often a known fetcher fetched a page of a location''s own site on a day, as its Cloudflare zone estimated. Written only by record_site_fetches().';

-- A member reads their locations' counts, and the operator reads every one. Nobody writes one
-- but record_site_fetches(), which only the worker calls, and a caller who is not signed in reads
-- none.
alter table public.site_fetches enable row level security;
revoke all on public.site_fetches from public, anon, authenticated;
grant select on public.site_fetches to authenticated;
grant all on public.site_fetches to service_role;

create policy "Members read their locations' site fetches"
  on public.site_fetches for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads site fetches"
  on public.site_fetches for select to authenticated
  using ((select public.is_operator()));

-- Whether a zone, named by its domain, holds a host: the domain itself or a name under it. The
-- shared package works out the same in zoneHolds().
create function public.zone_holds(zone text, host text)
returns boolean
language sql immutable set search_path = ''
as $$
  select host is not null and zone is not null
    and (host = lower(zone) or right(host, char_length(zone) + 1) = '.' || lower(zone));
$$;

revoke execute on function public.zone_holds(text, text) from public, anon, authenticated;

-- Keeps the zones a Cloudflare connection's token reaches, as its sync found them, and matches
-- each to the location of the organization whose website it holds. A match whose zone the token
-- no longer reaches, or that no longer holds its location's website, is taken away. A zone is
-- matched to one location, the one made first where several share the website, and not to a
-- location that has a zone already, nor where another of the organization's connections has the
-- same zone matched. Leaves where the connection stands to record_connection_sync(), which the
-- worker calls once the fetches are read. Returns each match, with the website and the last day
-- read. No row for a connection that is not a working or failing Cloudflare one. Worker only.
create function public.match_cloudflare_zones(connection uuid, reached jsonb)
returns table (location_id uuid, zone_id text, zone text, website text, read_through date)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  c public.connections;
  z record;
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
  set choices = reached
  where x.id = connection and x.kind = 'cloudflare'
    and (x.status = 'working' or (x.status = 'broken' and x.broken_reason = 'failing'))
  returning x.* into c;
  if not found then
    return;
  end if;

  delete from public.connection_locations m
  using public.locations l
  where m.connection_id = connection
    and l.id = m.location_id
    and not exists (
      select 1 from jsonb_array_elements(reached) e
      where e ->> 'id' = m.external_id
        and public.zone_holds(e ->> 'label', public.site_host(l.website))
    );

  update public.connection_locations m
  set external_label = e ->> 'label'
  from jsonb_array_elements(reached) e
  where m.connection_id = connection
    and m.external_id = e ->> 'id'
    and m.external_label is distinct from e ->> 'label';

  -- One zone at a time, the longest first, so a location in a zone of its own subdomain is matched
  -- to that one and the shorter zone goes to the next location it holds.
  for z in
    select e ->> 'id' as id, e ->> 'label' as label
    from jsonb_array_elements(reached) e
    order by char_length(e ->> 'label') desc, e ->> 'id'
  loop
    insert into public.connection_locations
      (connection_id, kind, location_id, external_id, external_label)
    select connection, 'cloudflare', l.id, z.id, z.label
    from public.locations l
    where l.organization_id = c.organization_id
      and public.zone_holds(z.label, public.site_host(l.website))
      and not exists (
        select 1 from public.connection_locations m
        where m.location_id = l.id and m.kind = 'cloudflare'
      )
      and not exists (
        select 1 from public.connection_locations m
        join public.connections x on x.id = m.connection_id
        where m.kind = 'cloudflare' and m.external_id = z.id
          and x.organization_id = c.organization_id
      )
    order by l.created_at, l.id
    limit 1;
  end loop;

  return query
    select m.location_id, m.external_id, m.external_label, l.website, m.read_through
    from public.connection_locations m
    join public.locations l on l.id = m.location_id
    where m.connection_id = connection
    order by m.matched_at, m.location_id;
end;
$$;

revoke execute on function public.match_cloudflare_zones(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.match_cloudflare_zones(uuid, jsonb) to service_role;

-- Keeps a location's fetches for the days from `from_day` to `to_day`, replacing whatever was
-- kept for those days, and, for a zone's read, that the zone was read through `to_day`. A count is
-- kept only for a known fetcher, a page from its first slash and a day in the range, under at
-- most fifty pages a day, the most fetched, with the rest counted together. For a zone's read,
-- nothing is written unless the zone is still matched to the location through a working or
-- failing connection. Returns how many counts were kept. Worker only.
create function public.record_site_fetches(
  location uuid,
  from_day date,
  to_day date,
  counted jsonb,
  connection uuid default null,
  sample boolean default false
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  written integer;
begin
  if from_day is null or to_day is null or from_day > to_day or to_day - from_day > 31
    or counted is null or jsonb_typeof(counted) <> 'array'
  then
    raise exception 'Fetches are kept for a run of at most a month of days.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.locations l where l.id = location) then
    return 0;
  end if;
  if connection is not null and not exists (
    select 1 from public.connection_locations m
    join public.connections c on c.id = m.connection_id
    where m.connection_id = connection and m.location_id = location and m.kind = 'cloudflare'
      and (c.status = 'working' or (c.status = 'broken' and c.broken_reason = 'failing'))
  ) then
    return 0;
  end if;

  delete from public.site_fetches f
  where f.location_id = location and f.day between from_day and to_day;

  with given as (
    select
      (e ->> 'day')::date as day,
      e ->> 'fetcher' as fetcher,
      left(e ->> 'path', 200) as path,
      round((e ->> 'count')::numeric)::integer as count
    from jsonb_array_elements(counted) e
  ),
  valid as (
    select * from given g
    where g.day between from_day and to_day
      and g.fetcher in (
        'gptbot', 'oai-searchbot', 'chatgpt-user',
        'claudebot', 'claude-searchbot', 'claude-user',
        'perplexitybot', 'perplexity-user',
        'googlebot', 'bingbot'
      )
      and g.path like '/%'
      and g.count > 0
  ),
  ranked as (
    select v.day, v.path,
      row_number() over (partition by v.day order by sum(v.count) desc, v.path collate "C") as place
    from valid v
    group by v.day, v.path
  )
  insert into public.site_fetches (location_id, day, fetcher, path, count, sample_data)
  select location, v.day, v.fetcher, case when r.place <= 50 then v.path else '' end,
    sum(v.count), sample
  from valid v
  join ranked r on r.day = v.day and r.path = v.path
  group by v.day, v.fetcher, case when r.place <= 50 then v.path else '' end;
  get diagnostics written = row_count;

  if connection is not null then
    update public.connection_locations m
    set read_through = greatest(coalesce(m.read_through, to_day), to_day)
    where m.connection_id = connection and m.location_id = location;
  end if;
  return written;
end;
$$;

revoke execute on function public.record_site_fetches(uuid, date, date, jsonb, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.record_site_fetches(uuid, date, date, jsonb, uuid, boolean)
  to service_role;

-- A location's site fetches since a day, of sample data or not, added up: by day and fetcher, the
-- five pages each fetcher fetched most, and each fetcher's fetches of the pages past the fiftieth
-- of their day; with the last day its zone was read through. Runs as the caller, so it adds up
-- only the rows the caller may read, and answers one value however many days are counted.
create function public.location_site_fetches(location uuid, since date, sample boolean)
returns jsonb
language sql stable set search_path = ''
as $$
  with counted as (
    select f.day, f.fetcher, f.path, f.count
    from public.site_fetches f
    where f.location_id = location and f.day >= since and f.sample_data = sample
  )
  select jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'fetcher', d.fetcher, 'count', d.count)
                       order by d.day, d.fetcher)
      from (
        select c.day, c.fetcher, sum(c.count)::integer as count
        from counted c
        group by c.day, c.fetcher
      ) d), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object('fetcher', p.fetcher, 'path', p.path, 'count', p.count)
                       order by p.fetcher, p.place)
      from (
        select c.fetcher, c.path, sum(c.count)::integer as count,
          row_number() over (
            partition by c.fetcher order by sum(c.count) desc, c.path collate "C"
          ) as place
        from counted c
        where c.path <> ''
        group by c.fetcher, c.path
      ) p
      where p.place <= 5), '[]'::jsonb),
    'other_pages', coalesce((
      select jsonb_agg(jsonb_build_object('fetcher', o.fetcher, 'count', o.count)
                       order by o.fetcher)
      from (
        select c.fetcher, sum(c.count)::integer as count
        from counted c
        where c.path = ''
        group by c.fetcher
      ) o), '[]'::jsonb),
    'read_through', (
      select m.read_through from public.connection_locations m
      where m.location_id = location and m.kind = 'cloudflare'
    )
  );
$$;

revoke execute on function public.location_site_fetches(uuid, date, boolean) from public, anon;
grant execute on function public.location_site_fetches(uuid, date, boolean)
  to authenticated, service_role;

-- A Cloudflare zone is matched by the worker, to the location whose website it holds, so an
-- owner's match of one is refused, with the reason. Otherwise as before.
create or replace function public.match_connection_location(connection uuid, location uuid, external text)
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

  if c.kind = 'cloudflare' then
    raise exception 'A Cloudflare zone is matched to the location whose website it holds.'
      using errcode = 'NC012';
  end if;

  if c.status = 'broken' then
    raise exception 'This account is not working, so nothing about it can be changed until it is.'
      using errcode = 'NC012';
  elsif c.status = 'paused' then
    raise exception 'This organization''s plan does not include this account any more.'
      using errcode = 'NC012';
  elsif c.status <> 'working' then
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

-- export_organization() carries the counts of the organization's site fetches. Otherwise as
-- before.
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
          geocoded_from, primary_category, what_we_do, paused_by_plan, last_scanned_at, created_at
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
    ), '[]')
  )
  from public.organizations o
  where o.id = org
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;
