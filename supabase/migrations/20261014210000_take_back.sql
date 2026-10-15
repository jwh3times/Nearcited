-- Adding the business details through WordPress, and taking back what an action did (issue #140,
-- docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md).
--
-- The details block goes at the end of a home page that is a WordPress page, marked as the
-- product's, so that it can be found again: to see that it is there, to update it when the
-- details on file change, and to take it away. Nothing else on the page is touched.
--
-- Its kind takes from the `wordpress` allowance, which is included or not: nothing is counted,
-- and nothing is proposed or carried out once the plan stops including it. What it replaced is
-- the product's own earlier block, read from the business's own site, and nothing limits how
-- long that may be kept.
--
-- Any member may take back an action that was done. Taking it back is a new action, already
-- approved by whoever asked, as asking again after a failure is: the record keeps who asked for
-- each. It puts back what was there before, where that is still what the action left there, and
-- a task the action marked done is no longer marked done by it. What was taken back is not
-- proposed again until what it rests on changes, as a thing that was declined is not.
--
-- The Worker deployed before this migration keeps working: it proposes no action of the new kind,
-- names the columns it reads, and finish_action() keeps its name and arguments.

insert into public.action_kind_terms (kind, allowance, keeps_seen_days)
values ('wordpress_details', 'wordpress', null);

alter table public.actions
  -- The action this one takes back, for one a member asked to have taken back.
  add column takes_back uuid references public.actions (id) on delete set null;

-- Taking back what an action did. Answers only a member of the location's organization: for
-- anyone else, the operator included, no row. Refuses an action that was not done, one of a
-- thing that has something waiting or on its way, one whose record of what it replaced is no
-- longer kept, and one a later action has since changed or taken back.
create function public.take_back_action(action uuid)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'done' then
    raise exception 'Only something that was done can be taken back.' using errcode = 'NC013';
  end if;
  if a.seen_dropped_at is not null then
    raise exception 'What it replaced is no longer kept, so it cannot be put back.'
      using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status in ('proposed', 'approved')
  ) then
    raise exception 'There is already one of these waiting or on its way.' using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status = 'done' and o.done_at > a.done_at
  ) then
    raise exception 'Something done since has changed this. Take that back instead.'
      using errcode = 'NC013';
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, takes_back)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, 'take-back:' || a.id,
       left('Take back: ' || a.summary, 300),
       jsonb_build_object('text', coalesce(a.approved_text, a.proposed_text)),
       a.seen ->> 'text', 'rule', 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.id)
    returning *;
end;
$$;

revoke execute on function public.take_back_action(uuid) from public, anon;
grant execute on function public.take_back_action(uuid) to authenticated;

-- An action that took another back, once done, also takes away the mark that one put on its
-- task. Otherwise as before.
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
  end if;
  return true;
end;
$$;

-- A thing that was taken back is not proposed again while what it rests on is the same, as a
-- thing that was declined is not: the member said no to it after seeing it done. Otherwise as
-- before.
create or replace function public.propose_action(
  location uuid,
  of_kind public.action_kind,
  via uuid,
  about text,
  resting_on text,
  what text,
  was jsonb,
  new_text text,
  author text,
  for_task uuid default null
)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  terms public.action_kind_terms;
  org uuid;
begin
  if exists (
    select 1 from public.actions a
    where a.location_id = location and a.kind = of_kind and a.subject = about
      and (
        a.status in ('proposed', 'approved')
        or (a.status = 'declined' and a.basis = resting_on)
        or (a.status = 'done' and a.basis = resting_on and exists (
          select 1 from public.actions b where b.takes_back = a.id and b.status = 'done'
        ))
      )
  ) then
    return;
  end if;

  select * into terms from public.action_kind_terms t where t.kind = of_kind;
  if terms.allowance is not null then
    select l.organization_id into org from public.locations l where l.id = location;
    if not coalesce(public.allowance_has_room(org, terms.allowance), false) then
      return;
    end if;
  end if;

  if for_task is not null and not exists (
    select 1 from public.recommendations r where r.id = for_task and r.location_id = location
  ) then
    raise exception 'A task belongs to the location its action is for.' using errcode = '22023';
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text, written_by,
       recommendation_id, seen_until)
    values
      (location, of_kind, via, about, resting_on, what, was, new_text, author, for_task,
       case when was is not null and terms.keeps_seen_days is not null
         then now() + make_interval(days => terms.keeps_seen_days) end)
    returning *;
end;
$$;
