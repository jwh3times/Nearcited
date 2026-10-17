-- A stronger model is charged for each location the subscription pays for, on each assistant on
-- Stronger (docs/adr/0022-a-stronger-model-is-charged-for-each-location.md). The amount kept is
-- the same column, read as a rate; only what it says it is changes. Nobody paid for Stronger
-- before this, so there is nothing to convert.

comment on column public.plan_prices.stronger_price_cents is
  'A month, in US cents, for each location paid for, on each assistant on Stronger. Null when this version sells no stronger model.';
