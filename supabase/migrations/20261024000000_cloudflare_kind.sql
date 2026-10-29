-- A Cloudflare account as a kind of connection, and fetches of a business's own site as a kind
-- of allowance (issue #156, docs/adr/0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md).
--
-- An owner makes a Cloudflare API token that can only read, and gives it to the product. That is
-- the sign-in, sealed and kept as every other is (docs/adr/0013-a-sign-in-is-sealed-by-the-
-- worker.md). The worker reads with it how often each known fetcher fetched each page of the
-- location's website.
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind and the allowance, and the next one uses them.
--
-- The Worker deployed before this migration is not touched by it: it neither offers nor reads a
-- Cloudflare connection, and it leaves a kind of allowance it does not know where it is.

alter type public.connection_kind add value 'cloudflare';

-- Included or not. Which plans include it is set on the plans themselves, by the operator, and
-- not here. Test organizations are given the new kind by the trigger on this table.
insert into public.allowance_kinds (key, counted) values ('fetches', false);
