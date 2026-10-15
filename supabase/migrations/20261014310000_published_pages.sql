-- Publishing a page's copy to a WordPress site, on approval (issue #140,
-- docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md).
--
-- Once the copy for a page task is written, and its location's site is connected, the worker
-- proposes publishing it as a new page of the site. A member may change the copy first. Carried
-- out, it does the page task's work, and where the page is is kept for the task as a member's
-- address is, saying the product published it, so the scans count the answers that cite it.
-- Taking it back moves the page to WordPress's trash and forgets the address.
--
-- Its kind takes from the `wordpress` allowance, which is included or not, and nothing limits how
-- long what it read from the business's own site may be kept.
--
-- The Worker deployed before this migration keeps working: it names the columns it reads,
-- calls set_prompt_page() and finish_action() with the arguments they had, and proposes nothing
-- of the new kind.

insert into public.action_kind_terms (kind, allowance, keeps_seen_days)
values ('wordpress_page', 'wordpress', null);

alter table public.prompt_pages
  -- The action that published it, where the product did. Null for an address a member gave.
  add column action_id uuid references public.actions (id) on delete set null;

-- A member's address replaces one the product kept, and is the member's from then on. Otherwise
-- as before.
create or replace function public.set_prompt_page(recommendation uuid, address text)
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
    (location_id, recommendation_id, url, set_by, set_by_email, set_at, action_id)
  values
    (r.location_id, recommendation, address, caller,
     (select u.email from auth.users u where u.id = caller), now(), null)
  on conflict (recommendation_id) do update
  set url = excluded.url, set_by = excluded.set_by, set_by_email = excluded.set_by_email,
      set_at = excluded.set_at, action_id = null
  returning x.*;
end;
$$;

-- Keeps where a page the product published is, for the task the action did. Only an address to
-- follow over https is kept: anything else is left for a member to give. True when it was kept.
-- Worker only.
create function public.keep_published_page(action uuid, address text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
begin
  select * into a from public.actions where id = action and status in ('approved', 'done');
  if not found or a.recommendation_id is null or address not like 'https://%'
    or char_length(address) > 500
  then
    return false;
  end if;

  insert into public.prompt_pages as x
    (location_id, recommendation_id, url, set_by, set_by_email, set_at, action_id)
  values (a.location_id, a.recommendation_id, address, null, null, now(), a.id)
  on conflict (recommendation_id) do update
  set url = excluded.url, set_by = null, set_by_email = null, set_at = excluded.set_at,
      action_id = excluded.action_id;
  return true;
end;
$$;

revoke execute on function public.keep_published_page(uuid, text) from public, anon, authenticated;
grant execute on function public.keep_published_page(uuid, text) to service_role;

-- Taking back a page the product published also forgets where it was. Otherwise as before.
create or replace function public.finish_action(action uuid, outcome text, why text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
  gives_back boolean;
begin
  if outcome not in ('done', 'failed', 'out_of_date', 'again') then
    raise exception 'An action ends done, failed, out_of_date or again.' using errcode = '22023';
  end if;

  select * into a from public.actions where id = action and status = 'approved' for update;
  if not found then
    return false;
  end if;
  gives_back := outcome in ('failed', 'out_of_date') and a.allowance_month is not null;

  update public.actions
  set status = case outcome
        when 'done' then 'done'
        when 'failed' then 'failed'
        when 'out_of_date' then 'lapsed'
        else status
      end::public.action_status,
      carrying_since = null,
      done_at = case when outcome = 'done' then now() else done_at end,
      failed_at = case when outcome = 'failed' then now() else failed_at end,
      failure = case when outcome in ('failed', 'again') then why else failure end,
      lapsed_at = case when outcome = 'out_of_date' then now() else lapsed_at end,
      lapse_reason = case when outcome = 'out_of_date' then 'out_of_date' else lapse_reason end,
      allowance_month = case when gives_back then null else allowance_month end
  where id = action;

  if gives_back then
    perform public.release_allowance(
      (select l.organization_id from public.locations l where l.id = a.location_id),
      (select t.allowance from public.action_kind_terms t where t.kind = a.kind),
      a.allowance_month
    );
  end if;

  if outcome = 'done' and a.recommendation_id is not null then
    update public.recommendations r
    set acted_at = now(), acted_by_action = action
    where r.id = a.recommendation_id and r.acted_by_action is null;
  end if;
  if outcome = 'done' and a.takes_back is not null then
    update public.recommendations r
    set acted_at = null, acted_by_action = null
    where r.acted_by_action = a.takes_back;
    delete from public.prompt_pages p where p.action_id = a.takes_back;
  end if;
  return true;
end;
$$;
