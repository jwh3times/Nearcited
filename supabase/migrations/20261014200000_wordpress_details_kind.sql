-- The business details, added to a home page through WordPress, as a kind of action (issue #140).
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind, and the next one uses it.
--
-- The Worker deployed before this migration is not touched by it: it proposes no action of the
-- new kind and reads none.

alter type public.action_kind add value 'wordpress_details';
