-- An answer subdomain as a kind of connection (issue #141,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md).
--
-- An owner points one subdomain of their own domain at the product with one DNS record, once, and
-- the product serves pages there. It has no sign-in: the record is the owner's say-so.
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind and the allowance, and the next one uses them.
--
-- The Worker deployed before this migration is not touched by it: it neither offers nor reads an
-- answer subdomain, and it leaves a kind of allowance it does not know where it is.

alter type public.connection_kind add value 'hosted_pages';

-- Included or not: a plan that includes it may have an answer subdomain for each location, with
-- no number a month. Test organizations are given the new kind by the trigger on this table, and
-- are never offered an answer subdomain all the same, since their pages would go out under a real
-- domain.
insert into public.allowance_kinds (key, counted) values ('hosted_pages', false);
