-- A search that showed nothing (issue #223, docs/adr/0024-a-search-that-showed-nothing-is-kept-
-- and-not-counted.md): when Google shows no AI Overview, no AI Mode answer, or no map or organic
-- results for a keyword, the result is kept as shown = false. It is not named either, and the
-- Worker counts it nowhere: not in the score, a rate, an alert or a recommendation.
--
-- The Worker deployed before this migration keeps working: it sends no shown, which
-- complete_scan() takes as true, and it reads none of the new column.

alter table public.scan_results add column shown boolean not null default true;

comment on column public.scan_results.shown is
  'False when Google showed nothing on this surface for the search. Such a result counts nowhere.';

-- The results kept before this, where Google returned nothing: a Google result that holds
-- nothing at all. One that showed anything holds a position, a business, a cited page or text.
update public.scan_results
set shown = false
where surface in ('google_local_pack', 'google_organic', 'google_ai_overview', 'google_ai_mode')
  and not mentioned
  and "position" is null
  and competitors = '[]'::jsonb
  and cited_urls = '[]'::jsonb
  and coalesce(answer_excerpt, '') = '';

-- complete_scan() keeps whether each result showed anything, true where a result does not say.
-- Otherwise as before.
create or replace function public.complete_scan(
  p_scan_id uuid,
  p_score numeric,
  p_results jsonb,
  p_recommendations jsonb,
  p_alerts jsonb default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_location uuid;
  v_sample boolean;
begin
  update public.scans
  set status = 'succeeded', visibility_score = p_score, error = null, finished_at = now(),
      tiers = (
        select coalesce(jsonb_object_agg(asked.surface, asked.tier), '{}'::jsonb)
        from (
          select distinct r.surface, coalesce(r.tier, 'standard') as tier
          from jsonb_to_recordset(p_results) as r (surface text, tier text)
        ) asked
      )
  where id = p_scan_id
  returning location_id, sample_data into v_location, v_sample;

  if v_location is null then
    raise exception 'scan % not found', p_scan_id using errcode = 'P0002';
  end if;

  -- A redelivered queue message re-runs the scan, so replace rather than append.
  delete from public.scan_results where scan_id = p_scan_id;

  insert into public.scan_results
    (scan_id, tracked_query_id, surface, shown, mentioned, "position", competitors, cited_urls,
     answer_excerpt, phones, tier)
  select
    p_scan_id, r.tracked_query_id, r.surface, coalesce(r.shown, true), r.mentioned, r."position",
    coalesce(r.competitors, '[]'::jsonb), coalesce(r.cited_urls, '[]'::jsonb), r.answer_excerpt,
    coalesce(r.phones, '[]'::jsonb), coalesce(r.tier, 'standard')
  from jsonb_to_recordset(p_results) as r (
    tracked_query_id uuid,
    surface public.surface,
    shown boolean,
    mentioned boolean,
    "position" integer,
    competitors jsonb,
    cited_urls jsonb,
    answer_excerpt text,
    phones jsonb,
    tier text
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
    (location_id, kind, subject, tracked_query_id, surface, tier, facts, since, scan_id,
     sample_data)
  select
    v_location, r.kind, r.subject, r.tracked_query_id, r.surface, coalesce(r.tier, 'standard'),
    r.facts, r.since, p_scan_id, v_sample
  from jsonb_to_recordset(coalesce(p_alerts -> 'raise', '[]'::jsonb)) as r (
    kind public.alert_kind,
    subject text,
    tracked_query_id uuid,
    surface public.surface,
    tier text,
    facts jsonb,
    since timestamptz
  )
  on conflict (location_id, kind, subject, sample_data) where cleared_at is null do nothing;
end;
$$;

-- export_organization() carries whether each result showed anything. Otherwise as before.
create or replace function public.export_organization(org uuid)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'exported_at', now(),
    'organization', (
      select to_jsonb(r) from (
        select id, name, max_locations, max_queries_per_location, max_manual_scans_per_month,
          scan_every_days, surfaces, stronger_surfaces, is_test, emails_report, allowances,
          plan_key, created_at
        from public.organizations where id = o.id
      ) r
    ),
    'subscription_status', (
      select s.status from public.subscriptions s where s.organization_id = o.id
    ),
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object('email', u.email, 'role', m.role, 'joined_at', m.created_at)
        order by m.created_at, m.role, u.email
      )
      from public.memberships m
      left join auth.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'),
    'locations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select id, organization_id, name, website, phone, address_line, city, region,
          postal_code, country_code, google_place_id, latitude, longitude, point_source,
          geocoded_from, primary_category, what_we_do, paused_by_plan, last_scanned_at, created_at
        from public.locations where organization_id = o.id
      ) r
    ), '[]'),
    'prompts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select q.id, q.location_id, q.kind, q.text, q.is_active, q.set_aside_by_plan, q.created_at
        from public.tracked_queries q
        join public.locations l on l.id = q.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'scans', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select s.id, s.location_id, s.status, s.trigger, s.visibility_score, s.error,
          s.sample_data, s.tiers, s.created_at, s.started_at, s.finished_at
        from public.scans s
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'answers', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sampled_at, r.id) from (
        select x.id, x.scan_id, x.tracked_query_id, x.surface, x.shown, x.mentioned, x.position,
          x.competitors, x.cited_urls, x.answer_excerpt, x.phones, x.tier, x.sampled_at
        from public.scan_results x
        join public.scans s on s.id = x.scan_id
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select t.id, t.location_id, t.scan_id, t.rule, t.title, t.detail, t.status, t.acted_at,
          t.acted_by_action, t.created_at
        from public.recommendations t
        join public.locations l on l.id = t.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.raised_at, r.id) from (
        select a.id, a.location_id, a.kind, a.tracked_query_id, a.surface, a.tier, a.facts, a.since,
          a.scan_id, a.raised_at, a.cleared_at, a.clear_reason, a.dismissed_at,
          a.dismissed_by_email
        from public.alerts a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'drafts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.asked_at, r.id) from (
        select d.id, d.location_id, d.recommendation_id, d.status, d.asked_by_email, d.asked_at,
          d.failure, d.kind, d.text, d.written_at, d.sample_data
        from public.drafts d
        join public.locations l on l.id = d.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'actions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.proposed_at, r.id) from (
        select a.id, a.location_id, a.kind, a.connection_id, a.summary, a.seen,
          a.seen_dropped_at, a.proposed_text, a.written_by, a.status, a.proposed_at, a.lapses_at,
          a.approved_by_email, a.approved_at, a.approved_text, a.declined_by_email,
          a.declined_at, a.decline_reason, a.done_at, a.failed_at, a.failure, a.lapsed_at,
          a.lapse_reason, a.retry_of, a.takes_back
        from public.actions a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'connections', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.connected_at, r.id) from (
        select c.id, c.organization_id, c.kind, c.label, c.status, c.connected_by_email,
          c.connected_at, c.removed_by_email, c.removal_requested_at, c.removed_at,
          c.broken_reason, c.broken_at, c.paused_at, c.removal_reason, c.last_synced_at,
          c.choices,
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'location_id', cl.location_id, 'external_id', cl.external_id,
                'external_label', cl.external_label, 'matched_at', cl.matched_at
              )
              order by cl.matched_at, cl.location_id
            )
            from public.connection_locations cl where cl.connection_id = c.id
          ), '[]') as matches
        from public.connections c where c.organization_id = o.id
      ) r
    ), '[]'),
    'listings', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.site) from (
        select g.location_id, g.site, g.url, g.set_by_email, g.set_at
        from public.listings g
        join public.locations l on l.id = g.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_addresses', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.recommendation_id) from (
        select p.location_id, p.recommendation_id, p.url, p.set_by_email, p.set_at, p.action_id
        from public.prompt_pages p
        join public.locations l on l.id = p.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.assistant, r.path) from (
        select v.location_id, v.day, v.assistant, v.path, v.count
        from public.visits v
        join public.locations l on l.id = v.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'hosted_pages', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.published_at, r.id) from (
        select h.id, h.location_id, n.hostname, h.slug, h.title, h.copy, h.published_at,
          h.taken_back_at
        from public.hosted_pages h
        join public.locations l on l.id = h.location_id
        left join public.answer_subdomains n on n.connection_id = h.connection_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_fetches', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.hosted_page_id, r.fetcher) from (
        select f.hosted_page_id, f.location_id, f.day, f.fetcher, f.count
        from public.hosted_page_fetches f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]')
  )
  from public.organizations o
  where o.id = org
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;
