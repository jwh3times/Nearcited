-- Drafts on the plans that include them (issue #138).
--
-- The kind of allowance exists, a draft is written, checked and counted, and no plan has had a
-- number. This gives each paid plan its number of drafts a month for each location it covers.
-- The free plan has none.
--
-- An organization already on one of those plans is given its plan's number now, as it would be
-- if the operator had set it: a plan gaining something takes effect at once. Only this one kind
-- is touched, so limits the operator set for one organization stay as they are. A test
-- organization keeps the generous number it was given when the kind was made.
--
-- The Worker deployed before this migration keeps working. A build from before drafts existed
-- reads the allowances, has no words for this kind, and leaves it where it is.

update public.plans p
set allowances = p.allowances || jsonb_build_object('drafts', given.each),
    updated_at = now()
from (values
  ('starter', 10),
  ('standard', 30),
  ('pro', 60),
  ('enterprise', 60)
) as given (key, each)
where p.key = given.key;

update public.organizations o
set allowances = o.allowances || jsonb_build_object('drafts', p.allowances -> 'drafts')
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'drafts'
  and not o.is_test;
