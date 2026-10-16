-- Publishing a page task's copy on the location's answer subdomain, on approval, and taking it
-- back (issue #141, docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md).
--
-- Once the copy for a page task is written and the location's answer subdomain is live, the
-- worker proposes serving it there. A member may change the copy first. Carried out, it is kept
-- in hosted_pages, which the Pages Worker serves, and where it is is kept for the task as a
-- WordPress page's address is, so the scans count the answers that cite it. Taking it back marks
-- the page taken back: its address then answers that it is gone.
--
-- Its kind takes from the `hosted_pages` allowance, which is included or not. What it read is
-- the product's own page, so nothing limits how long it may be kept.
--
-- The Worker deployed before this migration is not touched by it: it calls neither function and
-- proposes nothing of the new kind.

insert into public.action_kind_terms (kind, allowance, keeps_seen_days)
values ('hosted_page', 'hosted_pages', null);

-- Serves the page an approved action publishes, on its connection's answer subdomain while that
-- is live, for the task the action does, and returns where it is. Null for an action that is not
-- an approved one of this kind, or a subdomain that is not live. A page already served at that
-- address is a unique violation. Worker only.
create function public.publish_hosted_page(
  action uuid,
  page_slug text,
  page_title text,
  page_copy text
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
  s public.answer_subdomains;
begin
  select * into a from public.actions x
  where x.id = action and x.kind = 'hosted_page' and x.status = 'approved';
  if not found then
    return null;
  end if;
  select * into s from public.answer_subdomains x
  where x.connection_id = a.connection_id
    and x.live_at is not null
    and x.released_at is null
    and x.location_id = a.location_id;
  if not found then
    return null;
  end if;
  insert into public.hosted_pages
    (connection_id, location_id, recommendation_id, action_id, slug, title, copy)
  values
    (s.connection_id, a.location_id, a.recommendation_id, a.id, page_slug, page_title, page_copy);
  return 'https://' || s.hostname || '/' || page_slug;
end;
$$;

revoke execute on function public.publish_hosted_page(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_hosted_page(uuid, text, text, text) to service_role;

-- Takes back the page an action published: it is marked taken back, and its address answers that
-- it is gone. False where that action serves no page. Worker only.
create function public.take_back_hosted_page(action uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  with taken as (
    update public.hosted_pages
    set taken_back_at = now()
    where action_id = action and taken_back_at is null
    returning 1
  )
  select exists (select 1 from taken);
$$;

revoke execute on function public.take_back_hosted_page(uuid) from public, anon, authenticated;
grant execute on function public.take_back_hosted_page(uuid) to service_role;
