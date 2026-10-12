-- A fourth kind of alert: the answers give a phone number for the business that is not the one
-- on file (issue #136, docs/adr/0015-an-alert-is-kept-not-worked-out-again.md).
--
-- A scan keeps 280 characters of each answer and discards the rest, so the numbers an answer
-- gave for the business are read while the scan has the whole answer in hand, and kept with the
-- result. The alert is then counted over the window like anything else.
--
-- The Worker deployed before this migration goes on working: it sends results without `phones`,
-- which are kept as having given none.

alter type public.alert_kind add value 'phone';

alter table public.scan_results
  add column phones jsonb not null default '[]'::jsonb;

comment on column public.scan_results.phones is
  'The phone numbers a written answer gave for the business, in international form.';

alter table public.alerts drop constraint alerts_clear_reason_check;
alter table public.alerts add constraint alerts_clear_reason_check
  check (clear_reason in (
    'named_again', 'not_tracked', 'old_news', 'no_longer_given', 'now_on_file'
  ));

-- Worker only. As before, and each result now keeps the phone numbers its answer gave.
create or replace function public.complete_scan(
  p_scan_id uuid,
  p_score numeric,
  p_results jsonb,
  p_recommendations jsonb,
  p_alerts jsonb default null
)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_location uuid;
  v_sample boolean;
begin
  update public.scans
  set status = 'succeeded', visibility_score = p_score, error = null, finished_at = now()
  where id = p_scan_id
  returning location_id, sample_data into v_location, v_sample;

  if v_location is null then
    raise exception 'scan % not found', p_scan_id using errcode = 'P0002';
  end if;

  -- A redelivered queue message re-runs the scan, so replace rather than append.
  delete from public.scan_results where scan_id = p_scan_id;

  insert into public.scan_results
    (scan_id, tracked_query_id, surface, mentioned, "position", competitors, cited_urls,
     answer_excerpt, phones)
  select
    p_scan_id, r.tracked_query_id, r.surface, r.mentioned, r."position",
    coalesce(r.competitors, '[]'::jsonb), coalesce(r.cited_urls, '[]'::jsonb), r.answer_excerpt,
    coalesce(r.phones, '[]'::jsonb)
  from jsonb_to_recordset(p_results) as r (
    tracked_query_id uuid,
    surface public.surface,
    mentioned boolean,
    "position" integer,
    competitors jsonb,
    cited_urls jsonb,
    answer_excerpt text,
    phones jsonb
  );

  update public.locations set last_scanned_at = now() where id = v_location;

  -- A rule that fires again reopens if it had been marked done; a dismissal sticks.
  insert into public.recommendations (location_id, scan_id, rule, title, detail)
  select v_location, p_scan_id, r.rule, r.title, r.detail
  from jsonb_to_recordset(p_recommendations) as r (rule text, title text, detail text)
  on conflict (location_id, rule) do update
  set scan_id = excluded.scan_id,
      title = excluded.title,
      detail = excluded.detail,
      status = case
        when public.recommendations.status = 'done' then 'open'::public.recommendation_status
        else public.recommendations.status
      end;

  -- A rule that no longer fires has been resolved.
  update public.recommendations
  set status = 'done'
  where location_id = v_location
    and status = 'open'
    and rule not in (
      select r.rule from jsonb_to_recordset(p_recommendations) as r (rule text)
    );

  -- An alert that has ended is cleared, whether or not a member had dismissed it. Only this
  -- location's: the worker names an alert by its ID, and a wrong one changes nothing.
  update public.alerts a
  set cleared_at = now(), clear_reason = c.reason
  from jsonb_to_recordset(coalesce(p_alerts -> 'clear', '[]'::jsonb)) as c (id uuid, reason text)
  where a.id = c.id and a.location_id = v_location and a.cleared_at is null;

  -- An alert is raised once for a thing: while one is current, a second is not kept.
  insert into public.alerts
    (location_id, kind, subject, tracked_query_id, surface, facts, since, scan_id, sample_data)
  select
    v_location, r.kind, r.subject, r.tracked_query_id, r.surface, r.facts, r.since, p_scan_id,
    v_sample
  from jsonb_to_recordset(coalesce(p_alerts -> 'raise', '[]'::jsonb)) as r (
    kind public.alert_kind,
    subject text,
    tracked_query_id uuid,
    surface public.surface,
    facts jsonb,
    since timestamptz
  )
  on conflict (location_id, kind, subject, sample_data) where cleared_at is null do nothing;
end;
$$;
