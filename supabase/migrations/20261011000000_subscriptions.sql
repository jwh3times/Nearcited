-- Subscriptions: what the payment provider knows about an organization (issue #9, step 4).
--
-- One row for an organization that has ever gone through checkout: the provider's customer, the
-- subscription if there is one, and the status the provider last reported. The plan itself stays
-- on the organization, put there by apply_plan(). Only the worker writes here, from the
-- provider's webhook: nothing a member sends decides what they have paid for.

create table public.subscriptions (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  stripe_customer_id text not null unique,
  -- Null once a subscription has ended and before another starts.
  stripe_subscription_id text unique,
  -- The provider's own word for it: active, past_due, canceled and so on.
  status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'The payment provider''s customer and subscription for an organization. Written only by the worker.';

-- No API role writes the table, and the only one that reads it directly is the operator, who
-- reads every row. An owner reads their own through billing_state() below, which asks who is
-- calling instead of what they can see, so the operator is not taken for an owner.
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from public, anon, authenticated;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

create policy "The operator reads subscriptions"
  on public.subscriptions for select to authenticated
  using ((select public.is_operator()));

-- What checkout and the account pages need to know about an organization, for its owner and
-- nobody else: one row whether or not it has ever subscribed, no row for anyone who is not its
-- owner.
create function public.billing_state(org uuid)
returns table (
  organization_id uuid,
  is_test boolean,
  plan_key text,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text
)
language sql stable security definer set search_path = ''
as $$
  select o.id, o.is_test, o.plan_key, s.stripe_customer_id, s.stripe_subscription_id, s.status
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  where o.id = org
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;

revoke execute on function public.billing_state(uuid) from public, anon;
grant execute on function public.billing_state(uuid) to authenticated;
