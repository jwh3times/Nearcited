-- What a business does, in its owner's words (#138).
--
-- A draft is written from what a location holds and from this, and states nothing else about the
-- business. It is a column like the location's other details: the members who may change those
-- may change it, and nobody else reads it.
--
-- The Worker running before this is applied names the columns it reads and writes, so it neither
-- sees the new one nor blanks it.

alter table public.locations
  add column what_we_do text check (char_length(what_we_do) <= 600);
