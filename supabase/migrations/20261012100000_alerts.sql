-- Alerts: telling an owner when something measured gets worse (issue #136,
-- docs/adr/0015-an-alert-is-kept-not-worked-out-again.md).
--
-- An alert belongs to one location. The worker raises it when a scan finishes and its rule
-- fires, and clears it when a later scan shows the thing has ended. A member may dismiss one.
-- It is a kept row because it has to outlast the window it was worked out from: after seven
-- scans that did not name the business, the window holds nothing that says it ever was named.
--
-- The first kind is a drop: a prompt on one surface that named the business and has stopped.
--
-- The Worker deployed before this migration goes on working: it calls complete_scan() with the
-- four arguments it always has, and the fifth has a default.

create type public.alert_kind as enum ('drop');

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  kind public.alert_kind not null,
  -- What it is about, in the kind's own words, so the same thing is not raised twice. For a
  -- drop, the prompt and the surface.
  subject text not null check (char_length(subject) between 1 and 300),
  tracked_query_id uuid references public.tracked_queries (id) on delete cascade,
  surface public.surface,
  -- The observation it rests on, as it was counted when the alert was raised.
  facts jsonb not null,
  -- When what it says began.
  since timestamptz not null,
  -- The scan that raised it, and whether that scan ran on generated sample data. Sample scans
  -- and real ones never share a window, so their alerts are kept apart too.
  scan_id uuid references public.scans (id) on delete set null,
  sample_data boolean not null default false,
  raised_at timestamptz not null default now(),

  -- Set by the worker when a later scan shows it has ended.
  cleared_at timestamptz,
  clear_reason text check (clear_reason in ('named_again', 'not_tracked')),

  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_by_email text,
  dismissed_at timestamptz,

  check ((cleared_at is null) = (clear_reason is null))
);

comment on table public.alerts is
  'Something measured that got worse at a location, raised and cleared by the worker when a scan finishes.';

create index alerts_location on public.alerts (location_id, raised_at desc);

-- One alert at a time for a thing. A dismissed one still counts, so what a member dismissed is
-- not raised again until it has ended and begun afresh.
create unique index alerts_one_current
  on public.alerts (location_id, kind, subject, sample_data)
  where cleared_at is null;

-- Read by whoever can read the location, and by the operator. Raised and cleared only by the
-- worker, and dismissed only through the function below, which asks who is calling.
alter table public.alerts enable row level security;
revoke all on public.alerts from public, anon, authenticated;
grant select on public.alerts to authenticated;
grant all on public.alerts to service_role;

create policy "Members read their locations' alerts"
  on public.alerts for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads alerts"
  on public.alerts for select to authenticated
  using ((select public.is_operator()));

-- A member's dismissal of one alert. Answers only a member of the location's organization: for
-- anyone else, the operator included, no row. Dismissing one already dismissed, or already
-- cleared, changes nothing.
create function public.dismiss_alert(alert uuid)
returns setof public.alerts
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.alerts;
begin
  select * into a from public.alerts where id = alert for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;

  update public.alerts
  set dismissed_by = caller,
      dismissed_by_email = (select u.email from auth.users u where u.id = caller),
      dismissed_at = now()
  where id = alert and dismissed_at is null and cleared_at is null;

  return query select * from public.alerts x where x.id = alert;
end;
$$;

revoke execute on function public.dismiss_alert(uuid) from public, anon;
grant execute on function public.dismiss_alert(uuid) to authenticated;

-- Worker only. Writes a finished scan in one transaction: results, score, the location's
-- last-scanned time, the recommendations that scan produced, and now the alerts it cleared and
-- raised. `p_alerts` is {"clear": [{id, reason}], "raise": [{kind, subject, ...}]}.
drop function public.complete_scan(uuid, numeric, jsonb, jsonb);

create function public.complete_scan(
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
    (scan_id, tracked_query_id, surface, mentioned, "position", competitors, cited_urls, answer_excerpt)
  select
    p_scan_id, r.tracked_query_id, r.surface, r.mentioned, r."position",
    coalesce(r.competitors, '[]'::jsonb), coalesce(r.cited_urls, '[]'::jsonb), r.answer_excerpt
  from jsonb_to_recordset(p_results) as r (
    tracked_query_id uuid,
    surface public.surface,
    mentioned boolean,
    "position" integer,
    competitors jsonb,
    cited_urls jsonb,
    answer_excerpt text
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

revoke execute on function public.complete_scan(uuid, numeric, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_scan(uuid, numeric, jsonb, jsonb, jsonb)
  to service_role;
