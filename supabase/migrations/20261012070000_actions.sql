-- Actions: what the product does outside itself for a business, once a member said yes
-- (issue #135, docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0014-only-the-worker-carries-out-an-action.md).
--
-- An action belongs to one location. The worker proposes it, a member of the organization
-- approves or declines it, and the worker carries it out, because only the worker can read the
-- sign-in an action goes through. A request never proposes one and never carries one out.
--
--   proposed -> approved -> done
--                        -> failed
--            -> declined
--            -> lapsed      after fourteen days, or because the thing changed meanwhile
--
-- The Worker deployed before this migration is not touched by it: it reads none of this.

-- The kinds of action. `sample` changes a made-up line on a sample listing, so that proposing,
-- approving and the record can be exercised where the data is generated.
create type public.action_kind as enum ('sample');

create type public.action_status as enum (
  'proposed', 'approved', 'done', 'failed', 'declined', 'lapsed'
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  kind public.action_kind not null,
  -- The connection it goes through. Kept as a record when the connection's row is.
  connection_id uuid references public.connections (id) on delete set null,
  -- What it is about, in the kind's own words, so the same thing is not proposed twice.
  subject text not null check (char_length(subject) between 1 and 300),
  -- A fingerprint of what the proposal rests on. A thing that was declined is not proposed
  -- again until this changes.
  basis text not null,
  -- What it would do, in a sentence composed by rule.
  summary text not null check (char_length(summary) between 1 and 300),
  -- What was there when it was proposed, which is what the member is shown it replaces.
  seen jsonb,
  -- The text it would put there, and who wrote it.
  proposed_text text,
  written_by text not null check (written_by in ('rule', 'model')),
  status public.action_status not null default 'proposed',
  proposed_at timestamptz not null default now(),
  lapses_at timestamptz not null default now() + interval '14 days',

  approved_by uuid references auth.users (id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  -- What was approved, when a member changed the text first. Null when it went as proposed.
  approved_text text,

  declined_by uuid references auth.users (id) on delete set null,
  declined_by_email text,
  declined_at timestamptz,
  decline_reason text check (char_length(decline_reason) <= 200),

  -- How many times the worker has started on it, and when it last did.
  attempts integer not null default 0 check (attempts >= 0),
  carrying_since timestamptz,
  done_at timestamptz,
  failed_at timestamptz,
  failure text,
  lapsed_at timestamptz,
  lapse_reason text check (lapse_reason in ('expired', 'out_of_date')),
  -- The failed action a member asked to have tried again.
  retry_of uuid references public.actions (id) on delete set null
);

comment on table public.actions is
  'What the product does outside itself for a location, each proposed, approved by a member and carried out by the worker.';

create index actions_location on public.actions (location_id, proposed_at desc);

-- One open action for a thing: a second is not proposed, or asked for again, while one is
-- waiting or on its way.
create unique index actions_one_open
  on public.actions (location_id, kind, subject)
  where status in ('proposed', 'approved');

-- Read by whoever can read the location, and by the operator. Written only through the
-- functions below, which ask who is calling.
alter table public.actions enable row level security;
revoke all on public.actions from public, anon, authenticated;
grant select on public.actions to authenticated;
grant all on public.actions to service_role;

create policy "Members read their locations' actions"
  on public.actions for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads actions"
  on public.actions for select to authenticated
  using ((select public.is_operator()));

-- The sample account's made-up listings: the outside world for the sample kind of action,
-- which has no outside world. Only the worker reads or writes it.
create table public.sample_listings (
  connection_id uuid not null references public.connections (id) on delete cascade,
  external_id text not null,
  opening_line text,
  primary key (connection_id, external_id)
);

comment on table public.sample_listings is
  'What the sample account''s listings say. Stands in for an outside service on sample data.';

alter table public.sample_listings enable row level security;
revoke all on public.sample_listings from public, anon, authenticated;
grant all on public.sample_listings to service_role;

-- Proposes an action. Nothing is proposed, and no row comes back, when one for the same thing
-- is already waiting or on its way, or when one was declined and what it rests on is the same.
-- Worker only: a request never proposes.
create function public.propose_action(
  location uuid,
  of_kind public.action_kind,
  via uuid,
  about text,
  resting_on text,
  what text,
  was jsonb,
  new_text text,
  author text
)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
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

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text, written_by)
    values (location, of_kind, via, about, resting_on, what, was, new_text, author)
    returning *;
end;
$$;

revoke execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text)
  to service_role;

-- A member's yes to one action, with the text changed or not. Answers only a member of the
-- location's organization: for anyone else, the operator included, no row. Refuses one that is
-- no longer waiting, with the reason.
create function public.approve_action(action uuid, edited_text text default null)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
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

revoke execute on function public.approve_action(uuid, text) from public, anon;
grant execute on function public.approve_action(uuid, text) to authenticated;

-- A member's no to one action, with a reason or without. Answers only a member of the
-- location's organization. The same thing is not proposed again while what it rests on is the
-- same.
create function public.decline_action(action uuid, reason text default null)
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
  if a.status <> 'proposed' then
    raise exception 'This is no longer waiting for an answer.' using errcode = 'NC013';
  end if;

  update public.actions
  set status = 'declined',
      declined_by = caller,
      declined_by_email = (select u.email from auth.users u where u.id = caller),
      declined_at = now(),
      decline_reason = nullif(btrim(reason), '')
  where id = action;

  return query select * from public.actions x where x.id = action;
end;
$$;

revoke execute on function public.decline_action(uuid, text) from public, anon;
grant execute on function public.decline_action(uuid, text) to authenticated;

-- Asks for a failed action again. It is a new action, approved by whoever asked, that points at
-- the one that failed, so the record keeps both. Answers only a member of the location's
-- organization.
create function public.retry_action(action uuid)
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

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, approved_text, retry_of)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, a.basis, a.summary, a.seen,
       a.proposed_text, a.written_by, 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.approved_text, a.id)
    returning *;
end;
$$;

revoke execute on function public.retry_action(uuid) from public, anon;
grant execute on function public.retry_action(uuid) to authenticated;

-- The worker takes an approved action to carry out. It may go ahead when nobody else is on it,
-- or whoever was has been on it for ten minutes and is taken to have died. Returns which try
-- this is, counting from one, or zero when it may not go ahead. Worker only.
create function public.claim_action(action uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  try integer;
begin
  update public.actions
  set carrying_since = now(), attempts = attempts + 1
  where id = action
    and status = 'approved'
    and (carrying_since is null or carrying_since < now() - interval '10 minutes')
  returning attempts into try;
  return coalesce(try, 0);
end;
$$;

revoke execute on function public.claim_action(uuid) from public, anon, authenticated;
grant execute on function public.claim_action(uuid) to service_role;

-- What became of carrying an action out. `done`: it is as the action would make it. `failed`:
-- it could not be done, with the reason. `out_of_date`: the thing was no longer what the member
-- was shown, so nothing was written and the action lapses. `again`: it did not work this time
-- and may be tried again, so the worker lets go of it. Worker only. False when the action was
-- not approved, which leaves it as it is.
create function public.finish_action(action uuid, outcome text, why text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if outcome not in ('done', 'failed', 'out_of_date', 'again') then
    raise exception 'An action ends done, failed, out_of_date or again.' using errcode = '22023';
  end if;

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
      lapse_reason = case when outcome = 'out_of_date' then 'out_of_date' else lapse_reason end
  where id = action and status = 'approved';
  return found;
end;
$$;

revoke execute on function public.finish_action(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finish_action(uuid, text, text) to service_role;

-- Lapses every proposal that has waited its fourteen days. Returns how many. Worker only: the
-- daily run calls it.
create function public.lapse_actions()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  lapsed integer;
begin
  update public.actions
  set status = 'lapsed', lapsed_at = now(), lapse_reason = 'expired'
  where status = 'proposed' and lapses_at <= now();
  get diagnostics lapsed = row_count;
  return lapsed;
end;
$$;

revoke execute on function public.lapse_actions() from public, anon, authenticated;
grant execute on function public.lapse_actions() to service_role;
