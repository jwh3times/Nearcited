-- The kind of action that asks one customer for a review (issue #292, part of #146). A value added
-- to an enum cannot be used in the transaction that adds it, so it has a migration of its own and
-- the next one uses it.
--
-- The Worker deployed before this migration is not touched by it: it proposes nothing of the kind.

alter type public.action_kind add value 'review_request';
