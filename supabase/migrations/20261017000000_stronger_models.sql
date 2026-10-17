-- Stronger models: an owner pays for a stronger model on an assistant (issue #86, spec #215,
-- docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md).
--
-- Which plans offer one becomes an allowance like any other (docs/adr/0012), included or not, so
-- that taking it off a plan somebody pays for needs the announcement (docs/adr/0009). It goes on
-- the plans the old `stronger_models` mark was set for, and on the organizations already on them.
-- The mark stays until no deployed Worker reads it, and is dropped then.
--
-- What it costs is a third price on each price version: a month, in US cents, for each assistant
-- on Stronger, the same for either. The payment provider has a price of its own for each
-- assistant, because a subscription cannot hold one price twice and the webhook has to tell which
-- assistant was paid for. A version has all three or none of them.
--
-- Which assistants are on Stronger is written by apply_plan() alone, from what the subscription
-- the webhook read back pays for, and only where the plan includes the allowance. Nothing a
-- request can call writes it. Each result, and each drop, keeps the tier it was checked on.
--
-- The Worker deployed before this migration keeps working. It calls apply_plan(),
-- operator_set_plan_prices() and complete_scan() with the arguments it always had: an
-- organization's tiers are then left as they are, a price version is made with no stronger
-- price, and a result or a drop is kept as Standard.

insert into public.allowance_kinds (key, counted) values ('stronger_models', false);

update public.plans p
set allowances = p.allowances || jsonb_build_object('stronger_models', true),
    updated_at = now()
where p.stronger_models;

update public.organizations o
set allowances = o.allowances || jsonb_build_object('stronger_models', true)
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'stronger_models'
  and not o.is_test;

comment on column public.plans.stronger_models is
  'Replaced by the stronger_models allowance. Read by no Worker after #86; dropped once none deployed does.';

-- The stronger price, on every version and on the plan's row for the current one.
alter table public.plan_prices
  add column stronger_price_cents integer check (stronger_price_cents > 0),
  add column stripe_stronger_chatgpt_price_id text unique,
  add column stripe_stronger_claude_price_id text unique,
  add constraint plan_prices_stronger_whole check (
    (stronger_price_cents is null) = (stripe_stronger_chatgpt_price_id is null)
    and (stronger_price_cents is null) = (stripe_stronger_claude_price_id is null)
  );

alter table public.plans
  add column stronger_price_cents integer check (stronger_price_cents > 0),
  add column stripe_stronger_chatgpt_price_id text,
  add column stripe_stronger_claude_price_id text;

comment on column public.plan_prices.stronger_price_cents is
  'A month, in US cents, for each assistant on Stronger. Null when this version sells no stronger model.';

-- The assistants an organization pays to have checked on Stronger.
alter table public.organizations
  add column stronger_surfaces public.surface[] not null default '{}'
    check (stronger_surfaces <@ array['chatgpt', 'claude']::public.surface[]);

comment on column public.organizations.stronger_surfaces is
  'The assistants it pays for a stronger model on. Written by apply_plan() alone, from its subscription.';

-- The tier each check was made on. Everything kept before was Standard.
alter table public.scan_results
  add column tier text not null default 'standard' check (tier in ('standard', 'stronger'));

alter table public.alerts
  add column tier text not null default 'standard' check (tier in ('standard', 'stronger'));

-- And each scan keeps the tier it asked each surface on, so the score's history can say where a
-- tier changed without reading every result. Empty for a scan kept before.
alter table public.scans add column tiers jsonb not null default '{}';

comment on column public.scans.tiers is
  'The tier each surface was asked on, by surface. Written by complete_scan() from its results.';

comment on column public.alerts.tier is
  'For a drop, the tier of the checks it is about. A drop on one tier is not the same as on the other.';

-- apply_plan() takes the assistants the subscription pays a stronger model for. Left out, they
-- stay as they are. Either way none is kept where the plan does not include the allowance, and
-- only an assistant can be one. Otherwise as before. Its arguments change, so it is made again.
drop function public.apply_plan(uuid, text, integer);

create function public.apply_plan(
  org uuid,
  plan text,
  locations integer default null,
  stronger public.surface[] default null
)
returns public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  p public.plans;
  result public.organizations;
begin
  select * into p from public.plans where key = plan;
  if not found then
    raise exception 'There is no plan called %.', plan using errcode = '22023';
  end if;

  update public.organizations o
  set plan_key = p.key,
      max_locations = greatest(p.included_locations, coalesce(locations, 0)),
      max_queries_per_location = p.max_queries_per_location,
      max_manual_scans_per_month = p.max_manual_scans_per_month,
      scan_every_days = p.scan_every_days,
      emails_report = p.emails_report,
      allowances = p.allowances,
      surfaces = case
        when p.assistants >= 2 then array['chatgpt', 'claude']::public.surface[]
        when cardinality(o.surfaces) = 1 and o.surfaces[1] in ('chatgpt', 'claude') then o.surfaces
        else array['chatgpt']::public.surface[]
      end,
      stronger_surfaces = case
        when not (p.allowances ? 'stronger_models') then '{}'::public.surface[]
        else (
          select coalesce(array_agg(s order by s), '{}'::public.surface[])
          from (select distinct unnest(coalesce(stronger, o.stronger_surfaces)) as s) given
          where s in ('chatgpt', 'claude')
        )
      end
  where o.id = org
  returning o.* into result;

  if result.id is not null then
    perform public.fit_to_plan(org);
    perform public.fit_connections_to_plan(org);
  end if;
  return result;
end;
$$;

revoke execute on function public.apply_plan(uuid, text, integer, public.surface[])
  from public, anon, authenticated;
grant execute on function public.apply_plan(uuid, text, integer, public.surface[]) to service_role;

-- operator_set_plan_prices() takes the stronger price and the provider's price for it on each
-- assistant, which the Worker makes first. Left out, the version sells no stronger model.
-- Otherwise as before. Its arguments change, so it is made again.
drop function public.operator_set_plan_prices(text, integer, integer, text, text);

create function public.operator_set_plan_prices(
  plan text,
  price integer,
  extra_location_price integer,
  stripe_price text,
  stripe_extra_location_price text,
  stronger_price integer default null,
  stripe_stronger_chatgpt_price text default null,
  stripe_stronger_claude_price text default null
)
returns setof public.plans
language plpgsql security definer set search_path = ''
as $$
declare
  was public.plans;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into was from public.plans p where p.key = plan for update;
  if not found then
    return;
  end if;

  if plan = 'free' then
    raise exception 'The free plan has no price to change.' using errcode = 'NC008';
  end if;

  if exists (
    select 1 from public.price_changes c
    where c.plan_key = plan and c.called_off_at is null and c.completed_at is null
  ) then
    raise exception 'A price change has been announced for this plan. Call it off before changing its prices again.'
      using errcode = 'NC009';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'set_plan_prices',
    jsonb_build_object(
      'plan', plan,
      'from', jsonb_build_object(
        'price_cents', was.price_cents,
        'extra_location_price_cents', was.extra_location_price_cents,
        'stronger_price_cents', was.stronger_price_cents,
        'stripe_price_id', was.stripe_price_id,
        'stripe_extra_location_price_id', was.stripe_extra_location_price_id,
        'stripe_stronger_chatgpt_price_id', was.stripe_stronger_chatgpt_price_id,
        'stripe_stronger_claude_price_id', was.stripe_stronger_claude_price_id
      ),
      'to', jsonb_build_object(
        'price_cents', price,
        'extra_location_price_cents', extra_location_price,
        'stronger_price_cents', stronger_price,
        'stripe_price_id', stripe_price,
        'stripe_extra_location_price_id', stripe_extra_location_price,
        'stripe_stronger_chatgpt_price_id', stripe_stronger_chatgpt_price,
        'stripe_stronger_claude_price_id', stripe_stronger_claude_price
      )
    )
  );

  insert into public.plan_prices
    (plan_key, price_cents, extra_location_price_cents, stripe_price_id,
     stripe_extra_location_price_id, stronger_price_cents, stripe_stronger_chatgpt_price_id,
     stripe_stronger_claude_price_id)
  values (plan, price, extra_location_price, stripe_price, stripe_extra_location_price,
          stronger_price, stripe_stronger_chatgpt_price, stripe_stronger_claude_price);

  return query
    update public.plans p
    set price_cents = price,
        extra_location_price_cents = extra_location_price,
        stripe_price_id = stripe_price,
        stripe_extra_location_price_id = stripe_extra_location_price,
        stronger_price_cents = stronger_price,
        stripe_stronger_chatgpt_price_id = stripe_stronger_chatgpt_price,
        stripe_stronger_claude_price_id = stripe_stronger_claude_price,
        updated_at = now()
    where p.key = plan
    returning p.*;
end;
$$;

revoke execute on function
  public.operator_set_plan_prices(text, integer, integer, text, text, integer, text, text)
  from public, anon;
grant execute on function
  public.operator_set_plan_prices(text, integer, integer, text, text, integer, text, text)
  to authenticated, service_role;

-- complete_scan() keeps the tier each result and each drop was checked on, Standard where the
-- worker does not say, and on the scan the tier it asked each surface on. Otherwise as before.

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
    (scan_id, tracked_query_id, surface, mentioned, "position", competitors, cited_urls,
     answer_excerpt, phones, tier)
  select
    p_scan_id, r.tracked_query_id, r.surface, r.mentioned, r."position",
    coalesce(r.competitors, '[]'::jsonb), coalesce(r.cited_urls, '[]'::jsonb), r.answer_excerpt,
    coalesce(r.phones, '[]'::jsonb), coalesce(r.tier, 'standard')
  from jsonb_to_recordset(p_results) as r (
    tracked_query_id uuid,
    surface public.surface,
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

-- export_organization() carries each assistant's tier, and the tier of each result and drop.
-- Otherwise as before.
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
          postal_code, country_code, google_place_id, primary_category, what_we_do,
          paused_by_plan, last_scanned_at, created_at
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
        select x.id, x.scan_id, x.tracked_query_id, x.surface, x.mentioned, x.position,
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

-- A price change that makes Stronger dearer, or stops selling it, is a price that goes up, and
-- needs the thirty days' notice as the plan's own price does. Otherwise as before.
create or replace function public.operator_announce_price_change(
  plan text,
  effective timestamp with time zone
)
returns setof public.price_changes
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.plans;
  goes_up boolean;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  select * into p from public.plans where key = plan for update;
  if not found then
    return;
  end if;
  if p.stripe_price_id is null then
    raise exception 'This plan has no price at the payment provider to move anyone to.'
      using errcode = 'NC009';
  end if;

  select exists (
    select 1 from public.plan_prices v
    where v.plan_key = plan
      and v.stripe_price_id <> p.stripe_price_id
      and (
        v.price_cents < p.price_cents
        or (
          v.extra_location_price_cents is not null
          and (
            p.stripe_extra_location_price_id is null
            or v.extra_location_price_cents < p.extra_location_price_cents
          )
        )
        or (
          v.stronger_price_cents is not null
          and (
            p.stronger_price_cents is null
            or v.stronger_price_cents < p.stronger_price_cents
          )
        )
      )
  ) into goes_up;

  if goes_up and effective < now() + interval '30 days' then
    raise exception 'A price that goes up needs at least 30 days'' notice.' using errcode = 'NC009';
  end if;
  if effective < now() - interval '1 day' then
    raise exception 'Choose a day that has not passed.' using errcode = 'NC009';
  end if;

  insert into public.operator_actions (actor_id, organization_id, action, detail)
  values (
    (select auth.uid()),
    null,
    'announce_price_change',
    jsonb_build_object(
      'plan', plan,
      'price_cents', p.price_cents,
      'extra_location_price_cents', p.extra_location_price_cents,
      'stripe_price_id', p.stripe_price_id,
      'effective_at', effective
    )
  );

  return query
    insert into public.price_changes (plan_key, stripe_price_id, effective_at)
    values (plan, p.stripe_price_id, effective)
    returning *;
end;
$$;
