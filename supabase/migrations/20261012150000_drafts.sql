-- Drafts: wording written for one of an owner's tasks (issue #138,
-- docs/adr/0016-the-worker-writes-a-draft.md).
--
-- A task hands over a link and what to do. A draft is the wording the owner would otherwise have
-- to write: here, the note to the author of a page. It belongs to the task it was asked for,
-- which is a recommendation, and there is one for a task: asking again replaces it.
--
-- A member asks, through ask_draft(), and that is all a request does. The worker writes it,
-- because writing takes from the month's allowance and, on real data, calls a model, and
-- neither is a member's to do. The text that was last written stays where it is while another
-- is being written, and when that one cannot be.
--
-- A plan includes a number of drafts a month for each location, so this is also the first kind
-- of allowance. No plan is given any here.
--
-- The Worker deployed before this migration is not touched by it: it reads neither the table
-- nor the functions, and it leaves a kind of allowance it does not know where it is.

-- Test organizations are given the new kind by the trigger on this table.
insert into public.allowance_kinds (key, counted) values ('drafts', true);

create type public.draft_status as enum ('asked', 'written', 'failed');

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  -- The task it is for. One draft for a task.
  recommendation_id uuid not null unique references public.recommendations (id) on delete cascade,

  -- Where the ask in hand stands.
  status public.draft_status not null default 'asked',
  asked_by uuid references auth.users (id) on delete set null,
  asked_by_email text,
  asked_at timestamptz not null default now(),
  -- Set while a worker is writing it, so a second worker leaves it alone.
  writing_since timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  -- The month this ask took one from, as its first day. Null until the worker takes it, and
  -- again once it is given back.
  allowance_month date check (extract(day from allowance_month) = 1),
  -- Why the last ask wrote nothing, as a sentence for the page.
  failure text check (char_length(failure) <= 300),

  -- The draft that was last written. Kept while another is being written and when that fails.
  kind text check (kind in ('note')),
  text text check (char_length(text) between 1 and 4000),
  written_at timestamptz,
  -- True for generated sample text, which no model wrote.
  sample_data boolean not null default false,
  -- The model that wrote it. Null for sample text.
  model text check (char_length(model) <= 100),

  created_at timestamptz not null default now(),

  check ((text is null) = (written_at is null)),
  check ((text is null) = (kind is null)),
  check (status <> 'written' or text is not null)
);

comment on table public.drafts is
  'Wording written for one of a location''s tasks. Asked for by a member through ask_draft() and written only by the worker.';

create index drafts_location on public.drafts (location_id);
-- The asks nobody has written yet, for the run that queues them again.
create index drafts_asked on public.drafts (asked_at) where status = 'asked';

-- Read by whoever can read the location, and by the operator. Asked for only through the
-- function below, which asks who is calling, and written only by the worker.
alter table public.drafts enable row level security;
revoke all on public.drafts from public, anon, authenticated;
grant select on public.drafts to authenticated;
grant all on public.drafts to service_role;

create policy "Members read their locations' drafts"
  on public.drafts for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads drafts"
  on public.drafts for select to authenticated
  using ((select public.is_operator()));

-- A member's ask for a draft of one task, the first or another. Answers only a member of the
-- location's organization: for anyone else, the operator included, no row. Asking while one is
-- being written is the same ask, not a second. Refused when the month has no room; the worker
-- is what takes from the month, when it writes.
create function public.ask_draft(recommendation uuid)
returns setof public.drafts
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  r public.recommendations;
  d public.drafts;
begin
  -- The task's row is locked, so two asks at once are one after the other.
  select * into r from public.recommendations where id = recommendation for update;
  if not found or not public.can_access_location(r.location_id) then
    return;
  end if;

  select * into d from public.drafts x where x.recommendation_id = recommendation for update;
  if found and d.status = 'asked' then
    return next d;
    return;
  end if;

  if not coalesce(public.allowance_has_room(
    (select l.organization_id from public.locations l where l.id = r.location_id), 'drafts'), false)
  then
    raise exception 'Your plan has no more drafts this month.' using errcode = 'NC014';
  end if;

  return query
  insert into public.drafts as x
    (location_id, recommendation_id, status, asked_by, asked_by_email, asked_at)
  values
    (r.location_id, recommendation, 'asked', caller,
     (select u.email from auth.users u where u.id = caller), now())
  on conflict (recommendation_id) do update
  set status = 'asked', asked_by = excluded.asked_by, asked_by_email = excluded.asked_by_email,
      asked_at = excluded.asked_at, writing_since = null, attempts = 0, allowance_month = null,
      failure = null
  returning x.*;
end;
$$;

revoke execute on function public.ask_draft(uuid) from public, anon;
grant execute on function public.ask_draft(uuid) to authenticated;

-- The worker takes a draft to write, and with it one from the month's allowance unless this ask
-- holds one already. Says which try this is, counting from one, or zero when there is nothing
-- to write: nobody is asking, a worker is on it, or the month has no room, in which case the
-- ask is failed here with the reason.
create function public.claim_draft(draft uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  claim record;
  took date;
  try integer;
begin
  select * into d from public.drafts where id = draft for update;
  if not found or d.status <> 'asked'
    or (d.writing_since is not null and d.writing_since >= now() - interval '10 minutes')
  then
    return 0;
  end if;

  if d.allowance_month is null then
    select * into claim from public.claim_allowance(
      (select l.organization_id from public.locations l where l.id = d.location_id), 'drafts');
    if not coalesce(claim.claimed, false) then
      update public.drafts
      set status = 'failed', writing_since = null,
          failure = 'Your plan has no more drafts this month.'
      where id = draft;
      return 0;
    end if;
    took := date_trunc('month', now() at time zone 'UTC')::date;
  end if;

  update public.drafts
  set writing_since = now(), attempts = attempts + 1,
      allowance_month = coalesce(took, allowance_month)
  where id = draft
  returning attempts into try;
  return try;
end;
$$;

revoke execute on function public.claim_draft(uuid) from public, anon, authenticated;
grant execute on function public.claim_draft(uuid) to service_role;

-- What became of writing a draft:
--
--   written  the text is kept, with its kind, who wrote it and whether it is sample text. What
--            it took from the month stays taken.
--   failed   nothing was written. The text from before, if any, stays, and what this ask took
--            from the month is given back.
--   again    the worker lets go of it for another try, keeping what it took.
--
-- False when nobody was asking. Worker only.
create function public.finish_draft(
  draft uuid,
  outcome text,
  body text default null,
  of_kind text default null,
  by_model text default null,
  sample boolean default false,
  why text default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
begin
  if outcome not in ('written', 'failed', 'again') then
    raise exception 'A draft ends written, failed or again.' using errcode = '22023';
  end if;

  select * into d from public.drafts where id = draft and status = 'asked' for update;
  if not found then
    return false;
  end if;

  if outcome = 'written' then
    update public.drafts
    set status = 'written', text = body, kind = of_kind, model = by_model, sample_data = sample,
        written_at = now(), writing_since = null, failure = null
    where id = draft;
  elsif outcome = 'failed' then
    update public.drafts
    set status = 'failed', writing_since = null, failure = why, allowance_month = null
    where id = draft;
    if d.allowance_month is not null then
      perform public.release_allowance(
        (select l.organization_id from public.locations l where l.id = d.location_id),
        'drafts', d.allowance_month);
    end if;
  else
    update public.drafts set writing_since = null, failure = why where id = draft;
  end if;
  return true;
end;
$$;

revoke execute on function public.finish_draft(uuid, text, text, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.finish_draft(uuid, text, text, text, text, boolean, text)
  to service_role;
