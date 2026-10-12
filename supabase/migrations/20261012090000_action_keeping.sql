-- What is kept of an action and for how long, the task an action does, and the month's
-- allowance it takes from (issue #135, docs/adr/0014-only-the-worker-carries-out-an-action.md).
--
-- The Worker deployed before this migration keeps working: propose_action() gains an argument
-- with a default, claim_action() and finish_action() keep their names, arguments and answers,
-- and the new columns are ones it does not read.

-- What each kind of action is held to. A kind with no row is held to nothing.
create table public.action_kind_terms (
  kind public.action_kind primary key,
  -- The allowance an action of this kind takes from when it is carried out. Null: none.
  allowance text references public.allowance_kinds (key),
  -- How many days what it read from outside may be kept, counted from when it was read. Null:
  -- as long as the action is. Set for a platform that limits how long what is read from it may
  -- be held.
  keeps_seen_days integer check (keeps_seen_days between 1 and 3650)
);

comment on table public.action_kind_terms is
  'For each kind of action: the allowance it takes from, and how long what it replaced may be kept.';

-- Read and written by the worker and by migrations alone.
alter table public.action_kind_terms enable row level security;
revoke all on public.action_kind_terms from public, anon, authenticated;
grant all on public.action_kind_terms to service_role;

-- The sample listing is made up and nothing limits how long it may be held. It is given thirty
-- days all the same, so that dropping what an action replaced can be seen where the data is
-- generated.
insert into public.action_kind_terms (kind, keeps_seen_days) values ('sample', 30);

alter table public.actions
  -- The task this action does the work of, if it does one's.
  add column recommendation_id uuid references public.recommendations (id) on delete set null,
  -- The day `seen` may no longer be kept, and when it was dropped.
  add column seen_until timestamptz,
  add column seen_dropped_at timestamptz,
  -- The month whose allowance this action holds one of. Null when it holds none: its kind
  -- takes from no counted allowance, it has not been started, or what it took was given back.
  add column allowance_month date;

update public.actions a
set seen_until = a.proposed_at + make_interval(days => t.keeps_seen_days)
from public.action_kind_terms t
where t.kind = a.kind and t.keeps_seen_days is not null and a.seen is not null;

-- The action that did a task's work. Members may write `status` and `acted_at` on this table and
-- nothing else, so no request writes this.
alter table public.recommendations
  add column acted_by_action uuid references public.actions (id) on delete set null;

-- As before, the time is the database's. And what an action did stays marked: a member can take
-- back their own word that the work was done, and not the record that it was.
create or replace function public.stamp_recommendation_acted()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.acted_by_action is not null
    and new.acted_by_action is not distinct from old.acted_by_action
    and new.acted_at is distinct from old.acted_at
  then
    raise exception 'Nearcited did this task, so it stays marked done.' using errcode = 'NC013';
  end if;
  if new.acted_at is not null and new.acted_at is distinct from old.acted_at then
    new.acted_at := now();
  end if;
  return new;
end;
$$;

-- Whether an organization's month has room for one more of a kind of allowance: true for a kind
-- included without a number, false for one that is not included. Null for no such organization.
-- Worker only; the functions below ask it as their owner.
create function public.allowance_has_room(org uuid, of_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when o.allowances -> of_kind is null then false
    when o.allowances -> of_kind = 'true'::jsonb then true
    else (
      select coalesce(sum(u.used), 0)
      from public.allowance_use u
      where u.organization_id = org and u.kind = of_kind
        and u.month = date_trunc('month', now() at time zone 'UTC')::date
    ) < (o.allowances ->> of_kind)::integer * o.max_locations
  end
  from public.organizations o
  where o.id = org;
$$;

revoke execute on function public.allowance_has_room(uuid, text) from public, anon, authenticated;
grant execute on function public.allowance_has_room(uuid, text) to service_role;

-- Gives back what was taken from a month, when the work it was taken for was not done. Returns
-- the month's use afterwards, or null when nothing was counted for that month. Worker only.
create function public.release_allowance(
  org uuid,
  of_kind text,
  of_month date,
  amount integer default 1
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  left_used integer;
begin
  if amount is null or amount < 1 then
    raise exception 'An allowance is given back one or more at a time.' using errcode = '22023';
  end if;

  update public.allowance_use u
  set used = greatest(u.used - amount, 0)
  where u.organization_id = org and u.kind = of_kind and u.month = of_month
  returning u.used into left_used;
  return left_used;
end;
$$;

revoke execute on function public.release_allowance(uuid, text, date, integer)
  from public, anon, authenticated;
grant execute on function public.release_allowance(uuid, text, date, integer) to service_role;

comment on table public.allowance_use is
  'How much of each counted allowance an organization has used in a calendar month (UTC). Written only by claim_allowance() and release_allowance().';

-- Proposes an action, as before, and now also: says which task it does the work of, keeps the
-- day what it replaces may no longer be held, and proposes nothing of a kind whose allowance
-- has no room left this month.
drop function public.propose_action(
  uuid, public.action_kind, uuid, text, text, text, jsonb, text, text
);

create function public.propose_action(
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

revoke execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text, uuid)
  to service_role;

-- A member's yes, as before, and refused when the month has no room for it: a yes that could
-- only fail is better not taken.
create or replace function public.approve_action(action uuid, edited_text text default null)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
  terms public.action_kind_terms;
  changed text := nullif(btrim(edited_text), '');
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'proposed' or a.lapses_at <= now() then
    raise exception 'This is no longer waiting for a yes.' using errcode = 'NC013';
  end if;
  if changed is not null and a.proposed_text is null then
    raise exception 'This action has no text to change.' using errcode = 'NC013';
  end if;
  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and not coalesce(public.allowance_has_room(
    (select l.organization_id from public.locations l where l.id = a.location_id),
    terms.allowance), false)
  then
    raise exception 'Your plan has no more of these this month.' using errcode = 'NC013';
  end if;

  update public.actions
  set status = 'approved',
      approved_by = caller,
      approved_by_email = (select u.email from auth.users u where u.id = caller),
      approved_at = now(),
      approved_text = case when changed is distinct from a.proposed_text then changed end
  where id = action;

  return query select * from public.actions x where x.id = action;
end;
$$;

-- Asking again, as before, with the same refusal. The new action is for the same task, and what
-- it replaces may be kept no longer than the first one's could.
create or replace function public.retry_action(action uuid)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
  terms public.action_kind_terms;
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'failed' then
    raise exception 'Only an action that failed can be asked for again.' using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status in ('proposed', 'approved')
  ) then
    raise exception 'There is already one of these waiting or on its way.' using errcode = 'NC013';
  end if;
  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and not coalesce(public.allowance_has_room(
    (select l.organization_id from public.locations l where l.id = a.location_id),
    terms.allowance), false)
  then
    raise exception 'Your plan has no more of these this month.' using errcode = 'NC013';
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, approved_text, retry_of,
       recommendation_id, seen_until, seen_dropped_at)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, a.basis, a.summary, a.seen,
       a.proposed_text, a.written_by, 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.approved_text, a.id,
       a.recommendation_id, a.seen_until, a.seen_dropped_at)
    returning *;
end;
$$;

-- The worker takes an approved action to carry out, as before, and now takes one from the
-- month's allowance as it does, where the action's kind is counted and it does not hold one
-- already. When the month has no room the action is failed here, with the reason, and the
-- answer is zero: nothing is to be carried out.
create or replace function public.claim_action(action uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
  org uuid;
  terms public.action_kind_terms;
  claim record;
  took date;
  try integer;
begin
  select * into a from public.actions where id = action for update;
  if not found or a.status <> 'approved'
    or (a.carrying_since is not null and a.carrying_since >= now() - interval '10 minutes')
  then
    return 0;
  end if;
  select l.organization_id into org from public.locations l where l.id = a.location_id;
  if public.organization_held(org) then
    return 0;
  end if;

  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and a.allowance_month is null then
    select * into claim from public.claim_allowance(org, terms.allowance);
    if not coalesce(claim.claimed, false) then
      update public.actions
      set status = 'failed', failed_at = now(), carrying_since = null,
          failure = 'Your plan has no more of these this month.'
      where id = action;
      return 0;
    end if;
    -- A kind included without a number counts nothing, so there is nothing to give back.
    if claim.allowed is not null then
      took := date_trunc('month', now() at time zone 'UTC')::date;
    end if;
  end if;

  update public.actions
  set carrying_since = now(), attempts = attempts + 1,
      allowance_month = coalesce(took, allowance_month)
  where id = action
  returning attempts into try;
  return try;
end;
$$;

-- What became of carrying an action out, as before, and now also: one that ends without the
-- thing being done gives back what it took from the month, and one that is done marks the task
-- it does the work of, as of now, saying which action did it. A task an earlier action already
-- did keeps that mark.
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
  return true;
end;
$$;

-- Drops what an action replaced once the day it may be kept until has come, and says when. A
-- proposal still waiting then lapses as out of date: nobody can be shown what it would replace.
-- Returns how many were dropped. Worker only: the daily run calls it.
create function public.drop_expired_seen()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  dropped integer;
begin
  update public.actions
  set status = 'lapsed', lapsed_at = now(), lapse_reason = 'out_of_date'
  where status = 'proposed' and seen is not null and seen_until <= now();

  update public.actions
  set seen = null, seen_dropped_at = now()
  where seen is not null and seen_until <= now();
  get diagnostics dropped = row_count;
  return dropped;
end;
$$;

revoke execute on function public.drop_expired_seen() from public, anon, authenticated;
grant execute on function public.drop_expired_seen() to service_role;
