-- Two more kinds of alert: a business the answers name for the first time, and a site they cite
-- for the first time (issue #136, docs/adr/0015-an-alert-is-kept-not-worked-out-again.md).
--
-- "For the first time" is said of the whole record, not of the window of recent scans, so the
-- worker needs to read what every earlier scan's answers named and cited. A first sighting is
-- news and not a state: nothing ends it, and it is cleared as `old_news` once seven more scans
-- have passed.
--
-- The Worker deployed before this migration goes on working: it raises only drops and clears
-- only with the reasons it already has.

alter type public.alert_kind add value 'competitor';
alter type public.alert_kind add value 'site';

alter table public.alerts drop constraint alerts_clear_reason_check;
alter table public.alerts add constraint alerts_clear_reason_check
  check (clear_reason in ('named_again', 'not_tracked', 'old_news'));

-- What a location's scans named and cited before its latest ones, on the surfaces given: every
-- business as it was written, and every page's address up to its path. `skip` is how many of
-- the newest finished scans to leave out. Only scans of one kind: sample scans and real ones
-- never share a record. The worker compares names and sites itself, by the same rules it uses
-- everywhere else, so this returns what was written and decides nothing. Worker only.
create function public.seen_before(
  location uuid,
  sample boolean,
  skip integer,
  on_surfaces public.surface[]
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with earlier as (
    select s.id
    from public.scans s
    where s.location_id = location and s.status = 'succeeded' and s.sample_data = sample
    order by s.created_at desc
    offset greatest(skip, 0)
  ),
  answers as (
    select r.competitors, r.cited_urls
    from public.scan_results r
    where r.scan_id in (select id from earlier) and r.surface = any (on_surfaces)
  )
  select jsonb_build_object(
    'competitors', coalesce((
      select jsonb_agg(distinct named.name)
      from answers a, jsonb_array_elements_text(a.competitors) as named (name)
    ), '[]'::jsonb),
    'origins', coalesce((
      select jsonb_agg(distinct coalesce(
        substring(cited.url from '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+'), cited.url))
      from answers a, jsonb_array_elements_text(a.cited_urls) as cited (url)
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.seen_before(uuid, boolean, integer, public.surface[])
  from public, anon, authenticated;
grant execute on function public.seen_before(uuid, boolean, integer, public.surface[])
  to service_role;
