-- Hosted pages: the pages the product serves on a business's answer subdomain, and the one
-- function anyone may call to read one (issue #141,
-- docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md).
--
-- The Pages Worker serves them and holds no secret. It calls hosted_page() with the publishable
-- key, as anyone could, and the function answers only for an answer subdomain that is live, and
-- only with what the page itself shows: the page's words, and who and where the business is. A
-- page is put there and taken back only by the worker, carrying out an approved action, in a
-- later step; nothing here writes one.
--
-- The Worker deployed before this migration is not touched by it: it reads neither.

create table public.hosted_pages (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  -- The page task it does the work of, and the action that published it.
  recommendation_id uuid references public.recommendations (id) on delete set null,
  action_id uuid references public.actions (id) on delete set null,
  -- Where it is on the subdomain, made from its title as a WordPress page's address is.
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  title text not null check (char_length(title) between 1 and 300),
  -- The page copy as it was approved. The closing line is made from the location's details when
  -- the page is served, as they are then.
  copy text not null check (char_length(copy) between 1 and 20000),
  published_at timestamptz not null default now(),
  -- When it was taken back. The row stays, so its address answers that it is gone.
  taken_back_at timestamptz
);

comment on table public.hosted_pages is
  'A page served on an answer subdomain. Written only by the worker; read by anyone through hosted_page().';

-- One live page at an address on a subdomain.
create unique index hosted_pages_live on public.hosted_pages (connection_id, slug)
  where taken_back_at is null;
create index hosted_pages_location on public.hosted_pages (location_id);

-- A member reads their locations' pages, and the operator reads every one. Nobody writes one
-- through the API, and a caller who is not signed in reads them only through hosted_page().
alter table public.hosted_pages enable row level security;
revoke all on public.hosted_pages from public, anon, authenticated;
grant select on public.hosted_pages to authenticated;
grant all on public.hosted_pages to service_role;

create policy "Members read their locations' hosted pages"
  on public.hosted_pages for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads hosted pages"
  on public.hosted_pages for select to authenticated
  using ((select public.is_operator()));

-- What one address on an answer subdomain answers, for anyone: the list of its live pages at `/`,
-- a live page, a page that was taken back, or nothing there; each with who and where the business
-- is. Null for a host that is not a live answer subdomain, or that is being removed: the Pages
-- Worker then serves nothing at all. A trailing slash is the same address.
create function public.hosted_page(host text, path text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  s public.answer_subdomains;
  l public.locations;
  business jsonb;
  wanted text;
  p public.hosted_pages;
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

revoke execute on function public.hosted_page(text, text) from public;
grant execute on function public.hosted_page(text, text) to anon, authenticated, service_role;
