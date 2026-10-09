-- Plans: what is on sale (docs/adr/0006-plans-are-rows.md, issue #9).
--
-- A plan is a row, so a price or a limit can change without a deploy. Nothing here charges
-- anyone and nothing here changes what an organization may do yet: an organization's own limit
-- columns stay the thing the triggers enforce. A plan is where those values will come from.

create table public.plans (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(name) between 1 and 40),
  -- The order plans are shown in, cheapest first.
  position integer not null,
  -- False for a plan no longer sold. An organization already on it keeps it.
  on_sale boolean not null default true,
  -- A month, in US cents, for the locations the plan includes.
  price_cents integer not null check (price_cents >= 0),
  included_locations integer not null check (included_locations >= 1),
  -- A month, in US cents, for each location beyond those. Null when no more can be added.
  extra_location_price_cents integer check (extra_location_price_cents > 0),
  max_queries_per_location integer not null check (max_queries_per_location >= 0),
  -- How many assistants its scans ask. Fewer than there are means the owner chooses which.
  assistants integer not null check (assistants >= 1),
  scan_every_days integer not null check (scan_every_days between 1 and 30),
  -- Scans started by hand, across the organization, in a calendar month (UTC).
  max_manual_scans_per_month integer not null check (max_manual_scans_per_month >= 0),
  emails_report boolean not null,
  -- Whether its owner may pay for a stronger model. Nothing reads this yet.
  stronger_models boolean not null default false,
  -- The payment provider's names for the two prices. Null until the plan is set up there.
  stripe_price_id text,
  stripe_extra_location_price_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plans is
  'What is on sale: price, and what an organization on the plan may do. Read by everyone.';

insert into public.plans
  (key, name, position, price_cents, included_locations, extra_location_price_cents,
   max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month, emails_report)
values
  ('free',       'Free',       0,     0,  1, null,  2, 1, 14,  0, false),
  ('starter',    'Starter',    1,  2900,  1, 1000,  5, 1,  2,  2, true),
  ('standard',   'Standard',   2,  4900,  3, 1500, 10, 2,  2, 10, true),
  ('pro',        'Pro',        3, 12900,  3, 3500, 15, 2,  1, 30, true),
  ('enterprise', 'Enterprise', 4, 39900, 10, 2900, 15, 2,  1, 60, true);

-- The plan that will be offered stronger models first.
update public.plans set stronger_models = true where key = 'enterprise';

-- Everyone may read what is on sale, signed in or not: it is the price list. A plan taken off
-- sale is read by the organizations still on it, and by the operator. Nobody writes through the
-- API; the operator's editor will be a function of its own.
alter table public.plans enable row level security;
revoke all on public.plans from public, anon, authenticated;
grant select on public.plans to anon, authenticated;
grant all on public.plans to service_role;

-- Null means the organization's limits were set by hand and no plan changes them. That is every
-- organization that exists today.
alter table public.organizations
  add column plan_key text references public.plans (key);

comment on column public.organizations.plan_key is
  'The plan this organization is on. Null when its limits were set by hand.';

create policy "Anyone reads the plans on sale"
  on public.plans for select to anon, authenticated
  using (on_sale);

create policy "A member reads their organization's plan"
  on public.plans for select to authenticated
  using (key in (select o.plan_key from public.my_organizations() o));

create policy "The operator reads plans"
  on public.plans for select to authenticated
  using ((select public.is_operator()));

-- Limits the operator sets by hand take the organization off its plan, so that nothing later
-- puts the plan's values back over them. Otherwise as before.
create or replace function public.operator_set_limits(
  org uuid,
  locations integer,
  queries_per_location integer,
  manual_scans_per_day integer,
  every_days integer
)
returns setof public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  was public.organizations;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.organizations o where o.id = org for update;
  if not found then
    return;
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    org,
    'set_limits',
    jsonb_build_object(
      'from', jsonb_build_object(
        'plan_key', was.plan_key,
        'max_locations', was.max_locations,
        'max_queries_per_location', was.max_queries_per_location,
        'max_manual_scans_per_day', was.max_manual_scans_per_day,
        'scan_every_days', was.scan_every_days
      ),
      'to', jsonb_build_object(
        'plan_key', null,
        'max_locations', locations,
        'max_queries_per_location', queries_per_location,
        'max_manual_scans_per_day', manual_scans_per_day,
        'scan_every_days', every_days
      )
    )
  );

  return query
    update public.organizations o
    set plan_key = null,
        max_locations = locations,
        max_queries_per_location = queries_per_location,
        max_manual_scans_per_day = manual_scans_per_day,
        scan_every_days = every_days
    where o.id = org
    returning o.*;
end;
$$;
