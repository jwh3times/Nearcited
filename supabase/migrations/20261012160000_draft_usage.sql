-- What a draft used at a provider, so its cost is in the operator's spend (issue #138).
--
-- A row of provider_usage has been one scan's or one audit's calls on one surface. A draft is
-- neither, and it is a check of no surface, so the surface may now be left out and a row may
-- point at the draft it was for. Like the others, the row outlives what it describes: a draft
-- that is deleted with its task was still paid for.
--
-- usage_by_month() needs nothing: it adds up by month, organization and model, and a draft's row
-- carries its organization.
--
-- The Worker running before this is applied names a surface on every row it writes, as before.

alter table public.provider_usage alter column surface drop not null;

alter table public.provider_usage
  add column draft_id uuid references public.drafts (id) on delete set null;

comment on table public.provider_usage is
  'What scans, audits and drafts used at the providers. Written by the worker. No API role reads it.';
