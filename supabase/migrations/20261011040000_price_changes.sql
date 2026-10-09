-- Announcing a price change to the subscribers a plan already has (issue #9, step 6).
--
-- A new price is charged to new subscribers at once (20261011030000_plan_prices.sql). Whoever
-- already subscribes goes on paying what they were, until the operator announces the change to
-- them: a day from which their subscriptions are moved to the plan's present prices, each at its
-- own next renewal. A price that goes up needs at least thirty days' notice. One that only goes
-- down needs none.
--
-- A row in price_changes is one announcement for one plan. It names the version of the plan's
-- prices that subscribers are moved to, so while it is open the plan's prices cannot be changed
-- again: what the announcement said is what is charged.
--
-- price_change_notices is what was done for each organization: when its owners were told, when
-- they were reminded, when its subscription was moved. Only the worker writes it, as it sends
-- each email and makes each move.

create table public.price_changes (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.plans (key),
  -- The version subscribers are moved to: the plan's prices on the day it was announced.
  stripe_price_id text not null references public.plan_prices (stripe_price_id),
  -- From when subscriptions are moved, each at its first renewal on or after it.
  effective_at timestamptz not null,
  announced_at timestamptz not null default now(),
  -- When the reminders were queued, a week before it takes effect.
  reminded_at timestamptz,
  called_off_at timestamptz,
  -- When there was nobody left to move.
  completed_at timestamptz
);

comment on table public.price_changes is
  'An announcement that a plan''s current subscribers move to its present prices from a day. One open at a time for a plan.';

create unique index price_changes_one_open
  on public.price_changes (plan_key)
  where called_off_at is null and completed_at is null;

create table public.price_change_notices (
  price_change_id uuid not null references public.price_changes (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  announced_at timestamptz,
  reminded_at timestamptz,
  called_off_at timestamptz,
  moved_at timestamptz,
  -- Why nothing more is to be done for it, when that is so: already on the price, say.
  skipped text check (char_length(skipped) between 1 and 120),
  primary key (price_change_id, organization_id)
);

comment on table public.price_change_notices is
  'What a price change has done for each organization: told, reminded, moved. Written only by the worker.';

-- An announcement is read by anyone signed in: it says what a plan will cost and from when,
-- which a subscriber is told in any case and the price list already shows. What was done for
-- each organization is the operator's to read. No API role writes either.
alter table public.price_changes enable row level security;
revoke all on public.price_changes from public, anon, authenticated;
grant select on public.price_changes to authenticated;
grant all on public.price_changes to service_role;

create policy "Anyone signed in reads announced price changes"
  on public.price_changes for select to authenticated
  using (true);

alter table public.price_change_notices enable row level security;
revoke all on public.price_change_notices from public, anon, authenticated;
grant select on public.price_change_notices to authenticated;
grant all on public.price_change_notices to service_role;

create policy "The operator reads what a price change has done"
  on public.price_change_notices for select to authenticated
  using ((select public.is_operator()));

-- Announces that a plan's current subscribers move to its present prices from `effective`. It
-- answers only the operator and records that it did. The emails are the Worker's to send.
--
-- A change that puts anything up, against any price the plan has been sold at before, needs
-- thirty days. A plan that stops selling extra locations counts as putting them up.
--
-- Returns the announcement, or no row for anyone who is not the operator and for a plan that
-- does not exist.
create function public.operator_announce_price_change(plan text, effective timestamptz)
returns setof public.price_changes
language plpgsql security definer set search_path = ''
as $$
declare
  p public.plans;
  goes_up boolean;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into p from public.plans where key = plan for update;
  if not found then
    return;
  end if;
  if p.stripe_price_id is null then
    raise exception 'This plan has no price at the payment provider to move anyone to.'
      using errcode = 'NC009';
  end if;

  select exists (
    select 1 from public.plan_prices v
    where v.plan_key = plan
      and v.stripe_price_id <> p.stripe_price_id
      and (
        v.price_cents < p.price_cents
        or (
          v.extra_location_price_cents is not null
          and (
            p.stripe_extra_location_price_id is null
            or v.extra_location_price_cents < p.extra_location_price_cents
          )
        )
      )
  ) into goes_up;

  if goes_up and effective < now() + interval '30 days' then
    raise exception 'A price that goes up needs at least 30 days'' notice.' using errcode = 'NC009';
  end if;
  if effective < now() - interval '1 day' then
    raise exception 'Choose a day that has not passed.' using errcode = 'NC009';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'announce_price_change',
    jsonb_build_object(
      'plan', plan,
      'price_cents', p.price_cents,
      'extra_location_price_cents', p.extra_location_price_cents,
      'stripe_price_id', p.stripe_price_id,
      'effective_at', effective
    )
  );

  return query
    insert into public.price_changes (plan_key, stripe_price_id, effective_at)
    values (plan, p.stripe_price_id, effective)
    returning *;
end;
$$;

revoke execute on function public.operator_announce_price_change(text, timestamptz)
  from public, anon;
grant execute on function public.operator_announce_price_change(text, timestamptz)
  to authenticated;

-- Calls off a plan's announced change before it takes effect, so nobody is moved. Returns it, or
-- no row when there is none still to call off, and for anyone who is not the operator.
create function public.operator_call_off_price_change(plan text)
returns setof public.price_changes
language plpgsql security definer set search_path = ''
as $$
declare
  change public.price_changes;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into change
  from public.price_changes c
  where c.plan_key = plan and c.called_off_at is null and c.completed_at is null
    and c.effective_at > now()
  for update;
  if not found then
    return;
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'call_off_price_change',
    jsonb_build_object('plan', plan, 'price_change_id', change.id, 'effective_at', change.effective_at)
  );

  return query
    update public.price_changes c set called_off_at = now() where c.id = change.id returning c.*;
end;
$$;

revoke execute on function public.operator_call_off_price_change(text) from public, anon;
grant execute on function public.operator_call_off_price_change(text) to authenticated;

-- A plan's prices stay as announced while an announcement is open. Otherwise as before.
create or replace function public.operator_set_plan_prices(
  plan text,
  price integer,
  extra_location_price integer,
  stripe_price text,
  stripe_extra_location_price text
)
returns setof public.plans
language plpgsql security definer set search_path = ''
as $$
declare
  was public.plans;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.plans p where p.key = plan for update;
  if not found then
    return;
  end if;

  if plan = 'free' then
    raise exception 'The free plan has no price to change.' using errcode = 'NC008';
  end if;

  if exists (
    select 1 from public.price_changes c
    where c.plan_key = plan and c.called_off_at is null and c.completed_at is null
  ) then
    raise exception 'A price change has been announced for this plan. Call it off before changing its prices again.'
      using errcode = 'NC009';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'set_plan_prices',
    jsonb_build_object(
      'plan', plan,
      'from', jsonb_build_object(
        'price_cents', was.price_cents,
        'extra_location_price_cents', was.extra_location_price_cents,
        'stripe_price_id', was.stripe_price_id,
        'stripe_extra_location_price_id', was.stripe_extra_location_price_id
      ),
      'to', jsonb_build_object(
        'price_cents', price,
        'extra_location_price_cents', extra_location_price,
        'stripe_price_id', stripe_price,
        'stripe_extra_location_price_id', stripe_extra_location_price
      )
    )
  );

  insert into public.plan_prices
    (plan_key, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id)
  values (plan, price, extra_location_price, stripe_price, stripe_extra_location_price);

  return query
    update public.plans p
    set price_cents = price,
        extra_location_price_cents = extra_location_price,
        stripe_price_id = stripe_price,
        stripe_extra_location_price_id = stripe_extra_location_price,
        updated_at = now()
    where p.key = plan
    returning p.*;
end;
$$;
