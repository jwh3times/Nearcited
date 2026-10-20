-- Standing permission (issue #149, docs/adr/0025-standing-permission-is-checked-where-an-action-is-approved-and-carried-out.md).
--
-- An owner or admin who has seen three actions of one kind approved as proposed, carried out and
-- not taken back may give standing permission for that kind, for the whole organization. From
-- then on a proposal of that kind is approved as it is made, and the owners are told afterwards
-- in the daily notice. It ends when an owner or admin switches it off, when a member asks to take
-- back an action done under it, or when the organization's plan stops including it, and ending it
-- puts back to waiting whatever it approved that has not been carried out.
--
-- The Worker deployed before this migration goes on working. It calls propose_action() by
-- argument name, and the argument added here has a default; it names the columns it reads; and
-- no permission can be given until the Worker that has the routes is deployed.

insert into public.allowance_kinds (key, counted) values ('standing_permission', false);

-- Standing permission goes on the Pro and Enterprise plans, and an organization already on one of
-- those is given it now, as it would be if the operator had set it: a plan gaining something
-- takes effect at once. A test organization has every allowance, so it is given it too.
update public.plans p
set allowances = p.allowances || jsonb_build_object('standing_permission', true),
    updated_at = now()
where p.key in ('pro', 'enterprise');

update public.organizations o
set allowances = o.allowances || jsonb_build_object('standing_permission', true)
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'standing_permission'
  and not o.is_test;

update public.organizations o
set allowances = o.allowances || jsonb_build_object('standing_permission', true)
where o.is_test;

-- One row each time standing permission is given: for an organization and a kind of action, by
-- whom and when, and when it ended, by whom and why.
create table public.standing_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind public.action_kind not null,
  given_by uuid references auth.users (id) on delete set null,
  given_by_email text,
  given_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references auth.users (id) on delete set null,
  ended_by_email text,
  -- An owner or admin switched it off, a member asked to take back an action done under it, or
  -- the plan stopped including it.
  end_reason text check (end_reason in ('switched_off', 'taken_back', 'plan')),
  -- The action whose take-back ended it.
  ended_by_action uuid references public.actions (id) on delete set null,
  -- When the owners were told it was given, and that it ended.
  given_told_at timestamptz,
  ended_told_at timestamptz,
  constraint standing_permissions_ending check ((ended_at is null) = (end_reason is null))
);

comment on table public.standing_permissions is
  'An owner''s or admin''s yes in advance to every action of one kind, for the organization. Written only by the functions below.';

-- One at a time for an organization and a kind.
create unique index standing_permissions_current
  on public.standing_permissions (organization_id, kind)
  where ended_at is null;

-- A member reads their organization's, and the operator reads every one. Nothing writes one
-- through the API except the functions below.
alter table public.standing_permissions enable row level security;
revoke all on public.standing_permissions from public, anon, authenticated;
grant select on public.standing_permissions to authenticated;
grant all on public.standing_permissions to service_role;

create policy "Members read their organization's standing permissions"
  on public.standing_permissions for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads standing permissions"
  on public.standing_permissions for select to authenticated
  using ((select public.is_operator()));

alter table public.actions
  -- The standing permission that approved it, with who gave that permission and when, so the
  -- record can say so without a second read. Null when a member approved it.
  add column approved_under uuid references public.standing_permissions (id) on delete set null,
  add column approved_under_by_email text,
  add column approved_under_at timestamptz,
  -- Always waits for a member's yes, whatever permission is standing: a reply to a review of
  -- three stars or fewer is made so.
  add column always_asks boolean not null default false;

-- How many actions of a kind count toward standing permission for an organization, up to three:
-- approved as proposed by a member, carried out, and not asked to be taken back. For the
-- functions below.
create function public.standing_permission_count(org uuid, of_kind public.action_kind)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from (
    select 1
    from public.actions a
    join public.locations l on l.id = a.location_id
    where l.organization_id = org
      and a.kind = of_kind
      and a.status = 'done'
      and a.approved_under is null
      and a.approved_text is null
      and a.takes_back is null
      and not exists (select 1 from public.actions b where b.takes_back = a.id)
    limit 3
  ) counted;
$$;

revoke execute on function public.standing_permission_count(uuid, public.action_kind)
  from public, anon, authenticated;
grant execute on function public.standing_permission_count(uuid, public.action_kind)
  to service_role;

-- Puts an action that standing permission approved back to waiting for a member's yes, with a
-- fresh fourteen days, unless the worker is carrying it out at this moment. What it took from the
-- month is given back. For the functions below.
create function public.return_to_waiting(action uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
begin
  select * into a from public.actions
  where id = action and status = 'approved' and approved_under is not null
    and (carrying_since is null or carrying_since < now() - interval '10 minutes')
  for update;
  if not found then
    return false;
  end if;

  update public.actions
  set status = 'proposed', approved_at = null, approved_under = null,
      approved_under_by_email = null, approved_under_at = null,
      lapses_at = now() + interval '14 days', waiting_told_at = null,
      attempts = 0, carrying_since = null, failure = null, allowance_month = null
  where id = action;

  if a.allowance_month is not null then
    perform public.release_allowance(
      (select l.organization_id from public.locations l where l.id = a.location_id),
      (select t.allowance from public.action_kind_terms t where t.kind = a.kind),
      a.allowance_month
    );
  end if;
  return true;
end;
$$;

revoke execute on function public.return_to_waiting(uuid) from public, anon, authenticated;
grant execute on function public.return_to_waiting(uuid) to service_role;

-- Ends a standing permission and puts back to waiting what it approved that is not being carried
-- out. For the functions below.
create function public.end_permission(
  permission uuid,
  reason text,
  by_user uuid default null,
  by_action uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  waiting uuid;
begin
  update public.standing_permissions
  set ended_at = now(), end_reason = reason, ended_by = by_user,
      ended_by_email = (select u.email from auth.users u where u.id = by_user),
      ended_by_action = by_action
  where id = permission and ended_at is null;
  if not found then
    return;
  end if;
  for waiting in
    select a.id from public.actions a where a.approved_under = permission and a.status = 'approved'
  loop
    perform public.return_to_waiting(waiting);
  end loop;
end;
$$;

revoke execute on function public.end_permission(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.end_permission(uuid, text, uuid, uuid) to service_role;

-- An owner or admin gives standing permission for a kind of action. Answers an owner or admin of
-- the organization and no one else, the operator included. Refused where the plan does not
-- include it, where fewer than three of the kind count toward it, and where it already stands.
create function public.give_standing_permission(org uuid, of_kind public.action_kind)
returns setof public.standing_permissions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not public.has_org_role(org, array['owner', 'admin']::public.member_role[]) then
    return;
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = org and o.allowances ? 'standing_permission'
  ) then
    raise exception 'Your plan does not include standing permission.' using errcode = 'NC013';
  end if;
  if public.standing_permission_count(org, of_kind) < 3 then
    raise exception 'Standing permission is offered once three of these were approved as proposed and done.'
      using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.standing_permissions s
    where s.organization_id = org and s.kind = of_kind and s.ended_at is null
  ) then
    raise exception 'Standing permission is already given for these.' using errcode = 'NC013';
  end if;

  return query
    insert into public.standing_permissions (organization_id, kind, given_by, given_by_email)
    values (org, of_kind, caller, (select u.email from auth.users u where u.id = caller))
    returning *;
end;
$$;

revoke execute on function public.give_standing_permission(uuid, public.action_kind)
  from public, anon;
grant execute on function public.give_standing_permission(uuid, public.action_kind)
  to authenticated;

-- An owner or admin switches standing permission off. Answers an owner or admin of the
-- organization and no one else, the operator included. What it approved and is not being carried
-- out waits for a yes again, at once.
create function public.end_standing_permission(org uuid, of_kind public.action_kind)
returns setof public.standing_permissions
language plpgsql security definer set search_path = ''
as $$
declare
  current_one uuid;
begin
  if not public.has_org_role(org, array['owner', 'admin']::public.member_role[]) then
    return;
  end if;
  select s.id into current_one from public.standing_permissions s
  where s.organization_id = org and s.kind = of_kind and s.ended_at is null
  for update;
  if not found then
    raise exception 'There is no standing permission for these to end.' using errcode = 'NC013';
  end if;

  perform public.end_permission(current_one, 'switched_off', (select auth.uid()));
  return query select * from public.standing_permissions s where s.id = current_one;
end;
$$;

revoke execute on function public.end_standing_permission(uuid, public.action_kind)
  from public, anon;
grant execute on function public.end_standing_permission(uuid, public.action_kind)
  to authenticated;

-- What a location's Actions tab shows of standing permission: whether the plan includes it,
-- whether the caller may give or end it, and how many of each kind count toward it, up to three.
-- Answers a member of the location's organization and the operator; empty for anyone else.
create function public.standing_permission_state(location uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'included', o.allowances ? 'standing_permission',
    'may_change', public.has_org_role(o.id, array['owner', 'admin']::public.member_role[]),
    'counted', coalesce((
      select jsonb_object_agg(k.kind, public.standing_permission_count(o.id, k.kind))
      from (select unnest(enum_range(null::public.action_kind)) as kind) k
      where public.standing_permission_count(o.id, k.kind) > 0
    ), '{}'::jsonb)
  )
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where l.id = location
    and (public.can_access_location(location) or (select public.is_operator()));
$$;

revoke execute on function public.standing_permission_state(uuid) from public, anon;
grant execute on function public.standing_permission_state(uuid) to authenticated;

-- Proposes an action, as before, and now approves it as it is made where standing permission for
-- its kind stands for the organization, the plan includes it, and the action is not one that
-- always asks.
drop function public.propose_action(
  uuid, public.action_kind, uuid, text, text, text, jsonb, text, text, uuid
);

create function public.propose_action(
  location uuid,
  of_kind public.action_kind,
  via uuid,
  about text,
  resting_on text,
  what text,
  was jsonb,
  new_text text,
  author text,
  for_task uuid default null,
  asks_always boolean default false
)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  terms public.action_kind_terms;
  org uuid;
  permission public.standing_permissions;
begin
  if exists (
    select 1 from public.actions a
    where a.location_id = location and a.kind = of_kind and a.subject = about
      and (
        a.status in ('proposed', 'approved')
        or (a.status = 'declined' and a.basis = resting_on)
        or (a.status = 'done' and a.basis = resting_on and exists (
          select 1 from public.actions b where b.takes_back = a.id and b.status = 'done'
        ))
      )
  ) then
    return;
  end if;

  select l.organization_id into org from public.locations l where l.id = location;
  select * into terms from public.action_kind_terms t where t.kind = of_kind;
  if terms.allowance is not null then
    if not coalesce(public.allowance_has_room(org, terms.allowance), false) then
      return;
    end if;
  end if;

  if for_task is not null and not exists (
    select 1 from public.recommendations r where r.id = for_task and r.location_id = location
  ) then
    raise exception 'A task belongs to the location its action is for.' using errcode = '22023';
  end if;

  if not coalesce(asks_always, false) then
    select s.* into permission
    from public.standing_permissions s
    join public.organizations o on o.id = s.organization_id
    where s.organization_id = org and s.kind = of_kind and s.ended_at is null
      and o.allowances ? 'standing_permission';
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text, written_by,
       recommendation_id, seen_until, always_asks, status, approved_at, approved_under,
       approved_under_by_email, approved_under_at)
    values
      (location, of_kind, via, about, resting_on, what, was, new_text, author, for_task,
       case when was is not null and terms.keeps_seen_days is not null
         then now() + make_interval(days => terms.keeps_seen_days) end,
       coalesce(asks_always, false),
       case when permission.id is null then 'proposed' else 'approved' end::public.action_status,
       case when permission.id is not null then now() end,
       permission.id, permission.given_by_email, permission.given_at)
    returning *;
end;
$$;

revoke execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function
  public.propose_action(uuid, public.action_kind, uuid, text, text, text, jsonb, text, text, uuid, boolean)
  to service_role;

-- The worker takes an approved action to carry out, as before, and now first checks again that
-- whatever standing permission approved it still stands and may still approve it: when it does
-- not, the action waits for a yes again and the answer is zero.
create or replace function public.claim_action(action uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.actions;
  org uuid;
  terms public.action_kind_terms;
  claim record;
  took date;
  try integer;
begin
  select * into a from public.actions where id = action for update;
  if not found or a.status <> 'approved'
    or (a.carrying_since is not null and a.carrying_since >= now() - interval '10 minutes')
  then
    return 0;
  end if;
  select l.organization_id into org from public.locations l where l.id = a.location_id;
  if public.organization_held(org) then
    return 0;
  end if;

  if a.approved_under is not null and (
    a.always_asks
    or not exists (
      select 1 from public.standing_permissions s
      join public.organizations o on o.id = s.organization_id
      where s.id = a.approved_under and s.ended_at is null
        and o.allowances ? 'standing_permission'
    )
  ) then
    perform public.return_to_waiting(action);
    return 0;
  end if;

  select * into terms from public.action_kind_terms t where t.kind = a.kind;
  if terms.allowance is not null and a.allowance_month is null then
    select * into claim from public.claim_allowance(org, terms.allowance);
    if not coalesce(claim.claimed, false) then
      update public.actions
      set status = 'failed', failed_at = now(), carrying_since = null,
          failure = 'Your plan has no more of these this month.'
      where id = action;
      return 0;
    end if;
    -- A kind included without a number counts nothing, so there is nothing to give back.
    if claim.allowed is not null then
      took := date_trunc('month', now() at time zone 'UTC')::date;
    end if;
  end if;

  update public.actions
  set carrying_since = now(), attempts = attempts + 1,
      allowance_month = coalesce(took, allowance_month)
  where id = action
  returning attempts into try;
  return try;
end;
$$;

-- Taking back, as before, and now: asking to take back an action standing permission did ends
-- that permission, at the ask.
create or replace function public.take_back_action(action uuid)
returns setof public.actions
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  a public.actions;
begin
  select * into a from public.actions where id = action for update;
  if not found or not public.can_access_location(a.location_id) then
    return;
  end if;
  if a.status <> 'done' then
    raise exception 'Only something that was done can be taken back.' using errcode = 'NC013';
  end if;
  if a.seen_dropped_at is not null then
    raise exception 'What it replaced is no longer kept, so it cannot be put back.'
      using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status in ('proposed', 'approved')
  ) then
    raise exception 'There is already one of these waiting or on its way.' using errcode = 'NC013';
  end if;
  if exists (
    select 1 from public.actions o
    where o.location_id = a.location_id and o.kind = a.kind and o.subject = a.subject
      and o.status = 'done' and o.done_at > a.done_at
  ) then
    raise exception 'Something done since has changed this. Take that back instead.'
      using errcode = 'NC013';
  end if;

  if a.approved_under is not null then
    perform public.end_permission(a.approved_under, 'taken_back', caller, a.id);
  end if;

  return query
    insert into public.actions
      (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text,
       written_by, status, approved_by, approved_by_email, approved_at, takes_back)
    values
      (a.location_id, a.kind, a.connection_id, a.subject, 'take-back:' || a.id,
       left('Take back: ' || a.summary, 300),
       jsonb_build_object('text', coalesce(a.approved_text, a.proposed_text)),
       a.seen ->> 'text', 'rule', 'approved', caller,
       (select u.email from auth.users u where u.id = caller), now(), a.id)
    returning *;
end;
$$;

-- The day an organization's allowances stop including standing permission, by whatever path,
-- every permission it had ends as ended by the plan. Nothing gives one back but an owner or admin.
create function public.end_permissions_off_plan()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  current_one uuid;
begin
  for current_one in
    select s.id from public.standing_permissions s
    where s.organization_id = new.id and s.ended_at is null
  loop
    perform public.end_permission(current_one, 'plan');
  end loop;
  return new;
end;
$$;

revoke execute on function public.end_permissions_off_plan() from public, anon, authenticated;

create trigger end_permissions_off_plan
  after update of allowances on public.organizations
  for each row
  when (old.allowances ? 'standing_permission' and not new.allowances ? 'standing_permission')
  execute function public.end_permissions_off_plan();

-- export_organization() carries standing permissions, and which one approved each action.
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
          a.lapse_reason, a.retry_of, a.takes_back, a.approved_under, a.approved_under_by_email,
          a.approved_under_at, a.always_asks
        from public.actions a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'standing_permissions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.given_at, r.id) from (
        select s.id, s.kind, s.given_by_email, s.given_at, s.ended_at, s.ended_by_email,
          s.end_reason, s.ended_by_action
        from public.standing_permissions s where s.organization_id = o.id
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

revoke execute on function public.export_organization(uuid) from public, anon;
grant execute on function public.export_organization(uuid) to authenticated;
