-- Review requests as a kind of connection (issue #290, part of #146,
-- docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md,
-- docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md).
--
-- An owner or admin turns review requests on for one location. The product then asks each customer
-- whose receipt was copied to the location's receipt address for one review, by email. It has no
-- sign-in: the receipt address is the product's own.
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind and the allowance, and the next one uses them.
--
-- The Worker deployed before this migration is not touched by it: it neither offers nor reads
-- review requests, and it leaves a kind of allowance it does not know where it is.

alter type public.connection_kind add value 'review_requests';

-- A number a month for each location: each request sent takes one. No plan includes it yet: it is
-- tried on an organization whose limits are set by hand until the go-live change turns it on.
-- Test organizations are given the new kind by the trigger on this table, and never send.
insert into public.allowance_kinds (key, counted) values ('review_requests', true);
