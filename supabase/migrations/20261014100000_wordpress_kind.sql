-- A WordPress site as a kind of connection (issue #140,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md).
--
-- An owner approves one screen in their own WordPress admin, and WordPress gives the product an
-- application password for their account. That is the sign-in, sealed and kept as every other is
-- (docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md).
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind and the allowance, and the next one uses them.
--
-- The Worker deployed before this migration is not touched by it: it neither offers nor reads a
-- WordPress connection, and it leaves a kind of allowance it does not know where it is.

alter type public.connection_kind add value 'wordpress';

-- Included or not: a plan that includes it may connect a site, with no number a month. Test
-- organizations are given the new kind by the trigger on this table.
insert into public.allowance_kinds (key, counted) values ('wordpress', false);
