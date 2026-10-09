-- Every price a plan has been sold at, and the operator's way to set a new one (issue #9, step 6).
--
-- A plan's price is charged through the payment provider, where a price cannot be edited: a new
-- price is a new object there, and the subscriptions already running go on billing the old one.
-- So a plan's row says what a new subscriber pays, and this table keeps every pair of prices the
-- plan has ever been sold at. A subscription is matched to its plan by any of them, which is
-- what lets a current subscriber keep their price after it changes for everyone new.
--
-- A row is one version of a plan's prices: what the plan costs and what each extra location
-- costs, each with the provider's name for it. Both of the provider's prices are made new for
-- every version, so one of them names its version and no other.

create table public.plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.plans (key),
  -- A month, in US cents, for the locations the plan includes.
  price_cents integer not null check (price_cents > 0),
  -- A month, in US cents, for each location beyond those. Null when no more could be added.
  extra_location_price_cents integer check (extra_location_price_cents > 0),
  stripe_price_id text not null unique,
  stripe_extra_location_price_id text unique,
  created_at timestamptz not null default now(),
  check ((extra_location_price_cents is null) = (stripe_extra_location_price_id is null))
);

comment on table public.plan_prices is
  'Every pair of prices a plan has been sold at. The newest is on the plan''s own row; older ones are what current subscribers may still pay.';

create index plan_prices_plan on public.plan_prices (plan_key, created_at desc);

-- What each plan is sold at today is the first version of it.
insert into public.plan_prices
  (plan_key, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id)
select key, price_cents,
       case when stripe_extra_location_price_id is null then null else extra_location_price_cents end,
       stripe_price_id, stripe_extra_location_price_id
from public.plans
where stripe_price_id is not null and price_cents > 0;

-- Read by anyone signed in: a subscriber's own request has to recognise the price they pay, and
-- like the plan's own price IDs these identify a price and grant nothing. Written by no API
-- role: a version exists only because the function below made it.
alter table public.plan_prices enable row level security;
revoke all on public.plan_prices from public, anon, authenticated;
grant select on public.plan_prices to authenticated;
grant all on public.plan_prices to service_role;

create policy "Anyone signed in reads the prices plans have been sold at"
  on public.plan_prices for select to authenticated
  using (true);

-- Sets what a new subscriber pays for a plan. It answers only the operator, records what it
-- replaced, keeps the new version, and puts it on the plan's row. It does not touch a running
-- subscription or any organization: who pays what changes at the payment provider.
--
-- The provider's two price IDs are made by the Worker before this is called, because only it
-- can ask the provider. The free plan has no price to set.
--
-- Returns the plan, or no row for anyone who is not the operator and for a plan that does not
-- exist.
create function public.operator_set_plan_prices(
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

revoke execute on function public.operator_set_plan_prices(text, integer, integer, text, text)
  from public, anon;
grant execute on function public.operator_set_plan_prices(text, integer, integer, text, text)
  to authenticated;
