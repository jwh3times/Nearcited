-- A Google Analytics account as a kind of connection (issue #144,
-- docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md).
--
-- An owner or admin signs in with Google once, for read-only Analytics access. The refresh token
-- that comes back is the sign-in, sealed and kept as every other is (docs/adr/0013-a-sign-in-is-
-- sealed-by-the-worker.md). The worker reads with it how many sessions each assistant sent to each
-- page of the location's website.
--
-- A new value of an enum cannot be used in the transaction that adds it, so this migration only
-- adds the kind, and the next one uses it.
--
-- The Worker deployed before this migration is not touched by it: it neither offers nor reads a
-- Google Analytics connection.

alter type public.connection_kind add value 'google_analytics';
