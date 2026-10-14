-- Visits from assistants, counted by a line on the business's own site (issue #139,
-- docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md).
--
-- The product shows how often a business is named. Whether being named sends anyone to the
-- business is what its owner wants to know, and nothing here could say. A visit that arrives
-- from an assistant says where it came from, so it can be counted: the owner pastes one line
-- into their site, and the line reports such a visit and no other.
--
-- Whoever reports a visit is not signed in and never will be: it is a stranger's browser on
-- somebody else's site. So a visit is counted through one function, which answers anyone holding
-- the site's key, as an audit is read by its token (docs/adr/0002-audits-are-read-by-token.md).
-- The key is in the page's source for anyone to read, so the function trusts nothing but its
-- own clock and bounds what any one key can write.
--
-- Nothing is kept about a visitor. There is no row for a visit: only a count for a day, a
-- location, an assistant and a page.
--
-- No plan includes this yet. The kind of allowance is made here, which gives it to the test
-- organizations, and a later migration puts it on the plans.
--
-- The Worker deployed before this migration goes on working: it reads none of this, and a
-- location it makes is given its line by the trigger below.

insert into public.allowance_kinds (key, counted) values ('visits', false);

-- A location's line: the key the line on its site carries, and when it last answered a check.
create table public.visit_lines (
  location_id uuid primary key references public.locations (id) on delete cascade,
  -- Anyone who opens the site's source reads it. It says which location, and is no secret.
  key text not null unique check (key ~ '^[0-9a-f]{32}$'),
  key_made_at timestamptz not null default now(),
  -- The last day (UTC) the line answered from the location's own site when its owner asked.
  checked_on date
);

comment on table public.visit_lines is
  'The key the line on a location''s own site carries. Made with the location, and written only by the functions that note a check or replace the key.';

alter table public.visit_lines enable row level security;
revoke all on public.visit_lines from public, anon, authenticated;
grant select on public.visit_lines to authenticated;
grant all on public.visit_lines to service_role;

create policy "Members read their locations' lines"
  on public.visit_lines for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads lines"
  on public.visit_lines for select to authenticated
  using ((select public.is_operator()));

-- A key nobody could guess: which location a line belongs to should not be something to try.
create function public.new_site_key()
returns text
language sql volatile set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '');
$$;

revoke execute on function public.new_site_key() from public, anon, authenticated;

-- Every location has a line from the moment it is made. Runs as its owner: no API role may
-- write the table.
create function public.give_location_a_line()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.visit_lines (location_id, key) values (new.id, public.new_site_key());
  return new;
end;
$$;

revoke execute on function public.give_location_a_line() from public, anon, authenticated;

create trigger locations_line
  after insert on public.locations
  for each row execute function public.give_location_a_line();

insert into public.visit_lines (location_id, key)
select l.id, public.new_site_key() from public.locations l;

-- The visits counted. No row is a visit: each is how many arrived on one day (UTC) from one
-- assistant on one page.
create table public.visits (
  location_id uuid not null references public.locations (id) on delete cascade,
  day date not null,
  -- The assistants the shared list names (`VISIT_ASSISTANTS`). Add one there and here together.
  assistant text not null
    check (assistant in ('chatgpt', 'gemini', 'perplexity', 'copilot', 'claude')),
  -- The page landed on, from its first slash, without what follows a question mark. Empty for
  -- the visits to every page past the fiftieth of a day, which are counted together.
  path text not null check (path = '' or (path like '/%' and char_length(path) <= 200)),
  count integer not null check (count > 0),

  primary key (location_id, day, assistant, path)
);

comment on table public.visits is
  'How many visits from an assistant a location''s own site reported, by day, assistant and page. Written only by record_visit().';

alter table public.visits enable row level security;
revoke all on public.visits from public, anon, authenticated;
grant select on public.visits to authenticated;
grant all on public.visits to service_role;

create policy "Members read their locations' visits"
  on public.visits for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads visits"
  on public.visits for select to authenticated
  using ((select public.is_operator()));

-- The site an address is on, as it is compared: small letters, without "www.". The address
-- may be a whole one or a host alone. Null when there is none to find.
create function public.site_host(address text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(
    regexp_replace(
      lower(substring(address from '^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:[^/?#@]*@)?([^/?#:]+)')),
      '^www\.', ''),
    '');
$$;

revoke execute on function public.site_host(text) from public, anon, authenticated;

-- Whether a visit reported from `host` is one to count for the location: its organization's
-- plan includes visits and covers the location, and the page is on the website the location
-- has on file, or on a subdomain of it. A line copied onto somebody else's site counts nothing.
create function public.counts_visits(location uuid, host text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.locations l
    join public.organizations o on o.id = l.organization_id
    cross join lateral (
      select public.site_host(l.website) as kept, public.site_host(host) as seen
    ) site
    where l.id = location
      and not l.paused_by_plan
      and o.allowances ? 'visits'
      and site.kept is not null
      and (site.seen = site.kept
        or right(site.seen, char_length(site.kept) + 1) = '.' || site.kept)
  );
$$;

revoke execute on function public.counts_visits(uuid, text) from public, anon, authenticated;

-- Counts one visit from an assistant, for whoever holds the site's key. True when it was
-- counted. False, and nothing written, for a key that is nobody's, a page that is not on the
-- location's own site, a plan without visits, an assistant nobody knows, and a day that has
-- reached its ceiling.
--
-- The day is this function's own, never the caller's. A location's visits are counted one at a
-- time, so the ceilings hold: 1,000 visits a day, under at most 50 pages. The shared package
-- holds the same numbers (`visits.ts`).
create function public.record_visit(site_key text, host text, from_assistant text, page text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  line public.visit_lines;
  today date := (now() at time zone 'UTC')::date;
  landed text := left(split_part(split_part(page, '?', 1), '#', 1), 200);
begin
  select * into line from public.visit_lines v where v.key = site_key for update;
  if not found or not public.counts_visits(line.location_id, host) then
    return false;
  end if;
  if from_assistant is null
    or from_assistant not in ('chatgpt', 'gemini', 'perplexity', 'copilot', 'claude')
    or landed is null or landed not like '/%'
  then
    return false;
  end if;

  if (select coalesce(sum(v.count), 0) from public.visits v
      where v.location_id = line.location_id and v.day = today) >= 1000
  then
    return false;
  end if;

  -- A page is whatever the caller says it is, so the number of them is bounded here.
  if not exists (
      select 1 from public.visits v
      where v.location_id = line.location_id and v.day = today and v.path = landed)
    and (select count(distinct v.path) from public.visits v
         where v.location_id = line.location_id and v.day = today and v.path <> '') >= 50
  then
    landed := '';
  end if;

  insert into public.visits as v (location_id, day, assistant, path, count)
  values (line.location_id, today, from_assistant, landed, 1)
  on conflict (location_id, day, assistant, path) do update set count = v.count + 1;
  return true;
end;
$$;

revoke execute on function public.record_visit(text, text, text, text) from public;
grant execute on function public.record_visit(text, text, text, text)
  to anon, authenticated, service_role;

-- Notes that a location's line answered from its own site today, for whoever holds the key.
-- True when it was noted. It is how an owner sees that the line they pasted is there, and it
-- counts nothing.
create function public.check_visit_line(site_key text, host text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.visit_lines v
  set checked_on = (now() at time zone 'UTC')::date
  where v.key = site_key and public.counts_visits(v.location_id, host);
  return found;
end;
$$;

revoke execute on function public.check_visit_line(text, text) from public;
grant execute on function public.check_visit_line(text, text)
  to anon, authenticated, service_role;
