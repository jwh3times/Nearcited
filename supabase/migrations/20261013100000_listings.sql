-- Listings: where a business is on a site, as its owner gave it (issue #127,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md).
--
-- A task for a review site tells an owner to ask customers for reviews and hands over only the
-- page an assistant read, which is often a list or somebody else's page. To send a customer to
-- where a review is written the product needs the business's own page on that site, and nothing
-- held one: a location has a Google place ID and nothing for anywhere else.
--
-- A listing is the address of that page. A member gives it once and it is kept for the location
-- and the site, not for the task, so a task that comes back finds it there. The product does
-- not look for it and does not open it.
--
-- Which sites a task asks for one on is the list of known sites, which is code, so nothing here
-- knows it: the API refuses the rest. What the table does hold to is that an address is only
-- ever a link to follow over https, and that a location has a bounded number of them.
--
-- The Worker deployed before this migration is not touched by it: it reads neither the table
-- nor the functions.

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  -- The site, as the list of known sites names it: "bbb.org", never "www.bbb.org".
  site text not null check (site = lower(site) and char_length(site) between 3 and 253),
  url text not null check (url like 'https://%' and char_length(url) <= 500),
  set_by uuid references auth.users (id) on delete set null,
  set_by_email text,
  set_at timestamptz not null default now(),

  -- One for a location on a site.
  unique (location_id, site)
);

comment on table public.listings is
  'The address of a location''s own page on a site, as a member gave it. Set and removed only through set_listing() and remove_listing().';

-- Read by whoever can read the location, and by the operator. Written only through the
-- functions below, which ask who is calling.
alter table public.listings enable row level security;
revoke all on public.listings from public, anon, authenticated;
grant select on public.listings to authenticated;
grant all on public.listings to service_role;

create policy "Members read their locations' listings"
  on public.listings for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads listings"
  on public.listings for select to authenticated
  using ((select public.is_operator()));

-- A member gives a location's listing on a site, the first time or in place of the one before.
-- Answers only a member of the location's organization: for anyone else, the operator
-- included, no row. The time is the database's, and so is who it was.
create function public.set_listing(location uuid, on_site text, address text)
returns setof public.listings
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not public.can_access_location(location) then
    return;
  end if;

  -- The location's row is locked, so two members at once are one after the other and the count
  -- below holds.
  perform 1 from public.locations l where l.id = location for update;

  -- A site is whatever the caller says it is, so the number of them is bounded here. The list
  -- of known sites is far shorter than this.
  if not exists (
      select 1 from public.listings x where x.location_id = location and x.site = on_site)
    and (select count(*) from public.listings x where x.location_id = location) >= 50
  then
    raise exception 'A location holds a listing on at most 50 sites.' using errcode = 'NC015';
  end if;

  return query
  insert into public.listings as x (location_id, site, url, set_by, set_by_email, set_at)
  values
    (location, on_site, address, caller,
     (select u.email from auth.users u where u.id = caller), now())
  on conflict (location_id, site) do update
  set url = excluded.url, set_by = excluded.set_by, set_by_email = excluded.set_by_email,
      set_at = excluded.set_at
  returning x.*;
end;
$$;

revoke execute on function public.set_listing(uuid, text, text) from public, anon;
grant execute on function public.set_listing(uuid, text, text) to authenticated;

-- A member takes a location's listing on a site away. True when there was one. False for
-- anyone who is not a member of the location's organization, the operator included.
create function public.remove_listing(location uuid, on_site text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  removed integer;
begin
  if not public.can_access_location(location) then
    return false;
  end if;

  delete from public.listings x where x.location_id = location and x.site = on_site;
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke execute on function public.remove_listing(uuid, text) from public, anon;
grant execute on function public.remove_listing(uuid, text) to authenticated;
