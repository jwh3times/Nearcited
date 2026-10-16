-- Counting who fetches a hosted page, and winding an answer subdomain down when its plan stops
-- including hosted pages (issue #141,
-- docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md).
--
-- The Pages Worker counts a fetch of a live page by a known fetcher, an assistant's or a search
-- engine's, through record_page_fetch(), which anyone may call with the publishable key, as the
-- line on a business's site counts a visit (docs/adr/0017-a-visit-is-counted-for-whoever-holds-
-- the-site-key.md). Anyone can claim to be a fetcher, so the function trusts nothing it is told:
-- the day is its own, the page must be live on a live subdomain, the fetcher one of the known
-- ones, and a day's count stops at a ceiling. Nothing is kept about a fetch but the count for a
-- day, a page and a fetcher, and nothing is worked out from it.
--
-- A paused answer subdomain serves its pages for thirty days, then sends every visitor on to the
-- business's own site for ninety more, and only then is removed. Its owners are told once when
-- the pause begins.
--
-- The Worker deployed before this migration keeps working: hosted_page() keeps its arguments and
-- answers as before for anything not thirty days into a pause, and expire_paused_connections()
-- answers as before for every kind but hosted pages.

create table public.hosted_page_fetches (
  hosted_page_id uuid not null references public.hosted_pages (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  day date not null,
  -- The keys of PAGE_FETCHERS (packages/shared/src/hosted-pages.ts): add one in both.
  fetcher text not null check (fetcher in (
    'gptbot', 'oai-searchbot', 'chatgpt-user',
    'claudebot', 'claude-searchbot', 'claude-user',
    'perplexitybot', 'perplexity-user',
    'googlebot', 'bingbot'
  )),
  count integer not null check (count between 1 and 1000),
  primary key (hosted_page_id, day, fetcher)
);

comment on table public.hosted_page_fetches is
  'How often a known fetcher read a hosted page on a day. Counted by record_page_fetch() alone; anyone can pad it.';

create index hosted_page_fetches_location on public.hosted_page_fetches (location_id, day);

-- A member reads their locations' counts, and the operator reads every one. Nobody writes one but
-- record_page_fetch(), and a caller who is not signed in reads none.
alter table public.hosted_page_fetches enable row level security;
revoke all on public.hosted_page_fetches from public, anon, authenticated;
grant select on public.hosted_page_fetches to authenticated;
grant all on public.hosted_page_fetches to service_role;

create policy "Members read their locations' page fetches"
  on public.hosted_page_fetches for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads page fetches"
  on public.hosted_page_fetches for select to authenticated
  using ((select public.is_operator()));

-- Counts one fetch of a live page on a live answer subdomain by a known fetcher, for today
-- (UTC), up to a thousand a day for a page and a fetcher. Anything else is ignored, and the
-- caller is told nothing either way.
create function public.record_page_fetch(host text, path text, fetcher text)
returns void
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  p public.hosted_pages;
begin
  if host is null or char_length(host) > 253 or path is null or char_length(path) > 300
    or record_page_fetch.fetcher is null or record_page_fetch.fetcher not in (
      'gptbot', 'oai-searchbot', 'chatgpt-user',
      'claudebot', 'claude-searchbot', 'claude-user',
      'perplexitybot', 'perplexity-user',
      'googlebot', 'bingbot'
    )
  then
    return;
  end if;
  select h.* into p
  from public.hosted_pages h
  join public.answer_subdomains a on a.connection_id = h.connection_id
  join public.connections c on c.id = a.connection_id
  where a.hostname = lower(host)
    and a.released_at is null
    and a.live_at is not null
    and c.status in ('working', 'broken', 'paused')
    and h.slug = regexp_replace(path, '^/|/$', '', 'g')
    and h.taken_back_at is null;
  if not found then
    return;
  end if;
  insert into public.hosted_page_fetches as f (hosted_page_id, location_id, day, fetcher, count)
  values (p.id, p.location_id, (now() at time zone 'UTC')::date, record_page_fetch.fetcher, 1)
  on conflict (hosted_page_id, day, fetcher)
  do update set count = least(f.count + 1, 1000);
end;
$$;

revoke execute on function public.record_page_fetch(text, text, text) from public;
grant execute on function public.record_page_fetch(text, text, text)
  to anon, authenticated, service_role;

-- A location's page fetches since a day, added up for each page task and fetcher, with the last
-- day each fetched. Runs as the caller, so a caller reads only what the policies let them, and
-- answers few rows however many days are counted.
create function public.location_page_fetches(location uuid, since date)
returns table (recommendation_id uuid, fetcher text, fetches bigint, last_on date)
language sql stable security invoker set search_path = ''
as $$
  select h.recommendation_id, f.fetcher, sum(f.count), max(f.day)
  from public.hosted_page_fetches f
  join public.hosted_pages h on h.id = f.hosted_page_id
  where f.location_id = location and f.day >= since and h.recommendation_id is not null
  group by h.recommendation_id, f.fetcher;
$$;

revoke execute on function public.location_page_fetches(uuid, date) from public, anon;
grant execute on function public.location_page_fetches(uuid, date) to authenticated, service_role;

-- When the owners were last told their answer subdomain was paused. The worker's own: members are
-- not granted it.
alter table public.answer_subdomains add column pause_told_at timestamptz;

-- The answer subdomains paused after they went live, whose owners have not been told of this
-- pause. One that never went live has no pages to wind down. Worker only.
create function public.answer_subdomains_paused_untold()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select a.connection_id
  from public.answer_subdomains a
  join public.connections c on c.id = a.connection_id
  where c.status = 'paused'
    and a.live_at is not null
    and (a.pause_told_at is null or a.pause_told_at < c.paused_at)
  order by c.paused_at
  limit 100;
$$;

revoke execute on function public.answer_subdomains_paused_untold() from public, anon, authenticated;
grant execute on function public.answer_subdomains_paused_untold() to service_role;

-- An answer subdomain is removed a hundred and twenty days into a pause, once its pages have sent
-- visitors on for ninety; every other kind thirty days in, as before.
create or replace function public.expire_paused_connections()
returns setof uuid
language sql security definer set search_path = ''
as $$
  update public.connections
  set status = 'removing', removal_reason = 'plan', removal_requested_at = now()
  where status = 'paused'
    and paused_at < now() - case
      when kind = 'hosted_pages' then interval '120 days'
      else interval '30 days'
    end
  returning id;
$$;

-- An answer subdomain that never went live is let go thirty days after it was made, paused or not:
-- it has no pages to wind down. Otherwise as before.
create or replace function public.expire_unclaimed_answer_subdomains()
returns setof uuid
language sql security definer set search_path = ''
as $$
  update public.connections c
  set status = 'removing', removal_reason = 'unclaimed', removal_requested_at = now()
  from public.answer_subdomains a
  where a.connection_id = c.id
    and c.status in ('working', 'broken', 'paused')
    and a.live_at is null
    and c.connected_at < now() - interval '30 days'
  returning c.id;
$$;

-- hosted_page() now sends every address of a subdomain thirty days into a pause on to the
-- business's own site. Otherwise as before.
create or replace function public.hosted_page(host text, path text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  s public.answer_subdomains;
  l public.locations;
  business jsonb;
  wanted text;
  p public.hosted_pages;
  conn public.connections;
begin
  if host is null or char_length(host) > 253 or path is null or char_length(path) > 300 then
    return null;
  end if;
  select a.* into s
  from public.answer_subdomains a
  join public.connections c on c.id = a.connection_id
  where a.hostname = lower(host)
    and a.released_at is null
    and a.live_at is not null
    and c.status in ('working', 'broken', 'paused');
  if not found then
    return null;
  end if;
  select * into l from public.locations x where x.id = s.location_id;
  if not found then
    return null;
  end if;
  select * into conn from public.connections x where x.id = s.connection_id;
  business := jsonb_build_object(
    'name', l.name,
    'website', l.website,
    'address_line', l.address_line,
    'city', l.city,
    'region', l.region,
    'postal_code', l.postal_code,
    'country_code', l.country_code,
    'phone', l.phone
  );

  -- Thirty days into a pause every address sends a visitor on to the business's own site, until
  -- the subdomain is removed. One with no website on file says its pages are gone.
  if conn.status = 'paused' and conn.paused_at < now() - interval '30 days' then
    if l.website is null then
      return jsonb_build_object('kind', 'gone', 'business', business);
    end if;
    return jsonb_build_object('kind', 'redirect', 'business', business, 'to', l.website);
  end if;

  if path = '/' then
    return jsonb_build_object(
      'kind', 'list',
      'business', business,
      'pages', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('slug', h.slug, 'title', h.title, 'published_at', h.published_at)
            order by h.published_at desc
          )
          from public.hosted_pages h
          where h.connection_id = s.connection_id and h.taken_back_at is null
        ),
        '[]'::jsonb
      )
    );
  end if;

  wanted := regexp_replace(path, '^/|/$', '', 'g');
  select * into p from public.hosted_pages h
  where h.connection_id = s.connection_id and h.slug = wanted and h.taken_back_at is null;
  if found then
    return jsonb_build_object(
      'kind', 'page',
      'business', business,
      'title', p.title,
      'copy', p.copy,
      'published_at', p.published_at
    );
  end if;
  if exists (
    select 1 from public.hosted_pages h where h.connection_id = s.connection_id and h.slug = wanted
  ) then
    return jsonb_build_object('kind', 'gone', 'business', business);
  end if;
  return jsonb_build_object('kind', 'missing', 'business', business);
end;
$$;

