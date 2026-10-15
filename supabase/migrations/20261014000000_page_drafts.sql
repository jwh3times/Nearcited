-- A page that answers a prompt (issue #140).
--
-- An assistant asked one of a location's prompts names whoever its sources name. Where no answer
-- to a prompt named the business, a page of its own that answers the prompt in plain words is
-- something an assistant could read for it. The scans raise that as a task, `page:<prompt>`, by
-- the same path as every other recommendation, so nothing here knows the rule.
--
-- The copy for the page is the third kind of draft, asked for, written, checked and counted as the
-- note and the listing are. The kinds a draft may be are checked on the row, so the check is
-- remade to take this one.
--
-- Where the page went is the owner's to say: they may publish it anywhere. A member gives its
-- address once it is up, so the scans can count the answers that cited it. It is kept for the
-- task, one address for one page, and the product does not open it.
--
-- The Worker running before this is applied writes notes and listings, which the new check still
-- takes, and reads neither the table nor the functions.

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('note', 'listing', 'page'));

create table public.prompt_pages (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  -- The task the page is for: one page for a task.
  recommendation_id uuid not null unique references public.recommendations (id) on delete cascade,
  url text not null check (url like 'https://%' and char_length(url) <= 500),
  set_by uuid references auth.users (id) on delete set null,
  set_by_email text,
  set_at timestamptz not null default now()
);

comment on table public.prompt_pages is
  'Where the page for one of a location''s page tasks is, as a member gave it. Set and removed only through set_prompt_page() and remove_prompt_page().';

create index prompt_pages_location on public.prompt_pages (location_id);

-- Read by whoever can read the location, and by the operator. Written only through the
-- functions below, which ask who is calling.
alter table public.prompt_pages enable row level security;
revoke all on public.prompt_pages from public, anon, authenticated;
grant select on public.prompt_pages to authenticated;
grant all on public.prompt_pages to service_role;

create policy "Members read their locations' pages"
  on public.prompt_pages for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads pages"
  on public.prompt_pages for select to authenticated
  using ((select public.is_operator()));

-- A member gives the address of the page for a task, the first time or in place of the one
-- before. Answers only a member of the location's organization, and only for a page task: for
-- anyone else, the operator included, and for any other task, no row. The time is the
-- database's, and so is who it was.
create function public.set_prompt_page(recommendation uuid, address text)
returns setof public.prompt_pages
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  r public.recommendations;
begin
  select * into r from public.recommendations where id = recommendation;
  if not found or r.rule not like 'page:%' or not public.can_access_location(r.location_id) then
    return;
  end if;

  return query
  insert into public.prompt_pages as x
    (location_id, recommendation_id, url, set_by, set_by_email, set_at)
  values
    (r.location_id, recommendation, address, caller,
     (select u.email from auth.users u where u.id = caller), now())
  on conflict (recommendation_id) do update
  set url = excluded.url, set_by = excluded.set_by, set_by_email = excluded.set_by_email,
      set_at = excluded.set_at
  returning x.*;
end;
$$;

revoke execute on function public.set_prompt_page(uuid, text) from public, anon;
grant execute on function public.set_prompt_page(uuid, text) to authenticated;

-- A member takes the address of a task's page away. True when there was one. False for anyone
-- who is not a member of the location's organization, the operator included.
create function public.remove_prompt_page(recommendation uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.prompt_pages x
  where x.recommendation_id = recommendation and public.can_access_location(x.location_id);
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke execute on function public.remove_prompt_page(uuid) from public, anon;
grant execute on function public.remove_prompt_page(uuid) to authenticated;
