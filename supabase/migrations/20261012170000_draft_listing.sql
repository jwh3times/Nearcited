-- A second kind of draft: the description for a listing (issue #138).
--
-- A directory, or a review site that does not let a business ask for reviews, asks its owner for
-- a few sentences about the business. That is wording to write, as the note to a page's author
-- is. The kinds a draft may be are checked on the row, so the check is remade to take this one.
--
-- The Worker running before this is applied writes only notes, which the new check still takes.

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind in ('note', 'listing'));
