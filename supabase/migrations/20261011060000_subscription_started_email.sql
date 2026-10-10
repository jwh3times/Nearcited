-- The email that thanks an organization's owners when a subscription starts (issue #9).
--
-- The payment provider reports a new subscription several times over, close together, so "has
-- this one been thanked for?" has to be answered in the row itself: the worker claims the
-- subscription here before it sends anything, and only the first claim wins.

alter table public.subscriptions
  -- The subscription its owners were last thanked for starting. Null when none has been.
  add column welcomed_subscription_id text;

-- Subscriptions that are already running started before there was an email to send.
update public.subscriptions set welcomed_subscription_id = stripe_subscription_id;

-- Claims the thanks for a subscription: true for the first caller for that subscription, false
-- for every one after and for an organization with no subscription kept. One statement, so of
-- two calls at once the second finds the row already claimed. Only the worker calls it.
create function public.claim_subscription_start(org uuid, subscription text)
returns boolean
language sql volatile set search_path = ''
as $$
  with claimed as (
    update public.subscriptions
    set welcomed_subscription_id = subscription
    where organization_id = org
      and welcomed_subscription_id is distinct from subscription
    returning 1
  )
  select exists (select 1 from claimed);
$$;

revoke execute on function public.claim_subscription_start(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_subscription_start(uuid, text) to service_role;
