-- Teammates (issue #10). An owner invites an address as an admin or a member; the person signs in
-- with that address and accepts or declines. Signing in is the proof: there is no secret link.
-- Every change to who is in an organization goes through a function below that answers an owner,
-- or the person themselves, and keeps the organization an owner. An account still has one
-- organization, so an invitation is not accepted while the person belongs to another.

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Trimmed and lower-cased, so it matches the address the person signs in with in any case.
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  -- An owner is made only of someone who has joined.
  role public.member_role not null check (role in ('admin', 'member')),
  -- Who sent it last, kept if they leave.
  invited_by uuid references auth.users (id) on delete set null,
  invited_by_email text,
  created_at timestamptz not null default now(),
  sent_at timestamptz not null default now(),
  -- Fourteen days after it was last sent. Past it, it is expired: read, never written.
  expires_at timestamptz not null default now() + interval '14 days',
  ended_at timestamptz,
  -- Accepted or declined by the person, or cancelled by an owner, which is also how a declined
  -- or expired one leaves the list.
  outcome text check (outcome in ('accepted', 'declined', 'cancelled')),
  constraint invitations_ending check ((ended_at is null) = (outcome is null))
);

comment on table public.invitations is
  'An owner''s invitation of an address into the organization. Written only by the functions below.';

-- One not ended for an address in an organization.
create unique index invitations_open on public.invitations (organization_id, email)
  where ended_at is null;
create index invitations_to on public.invitations (email) where ended_at is null;

-- Owners read their organization's, and the operator reads every one. Nothing writes one through
-- the API except the functions below. The person invited reads theirs through my_invitations().
alter table public.invitations enable row level security;
revoke all on public.invitations from public, anon, authenticated;
grant select on public.invitations to authenticated;
grant all on public.invitations to service_role;

create policy "Owners read their organization's invitations"
  on public.invitations for select to authenticated
  using (public.has_org_role(organization_id, array['owner']::public.member_role[]));

create policy "The operator reads invitations"
  on public.invitations for select to authenticated
  using ((select public.is_operator()));

-- Who is in an organization changes only through the functions below, which keep an owner. The
-- table policies could not: they let the last owner remove or demote themselves. Nothing wrote
-- through them, so the Worker from before keeps working.
drop policy "Owners add members" on public.memberships;
drop policy "Owners change member roles" on public.memberships;
drop policy "Owners remove members" on public.memberships;
revoke insert, update, delete on public.memberships from public, anon, authenticated;

-- The caller's own address, as invitations keep it.
create function public.my_address()
returns text
language sql stable security definer set search_path = ''
as $$
  select lower(btrim(u.email)) from auth.users u where u.id = (select auth.uid());
$$;

revoke execute on function public.my_address() from public, anon, authenticated;
grant execute on function public.my_address() to service_role;

-- Refuses a change that would leave the organization with no owner. Called with the organization
-- locked, so two owners stepping down at once cannot both pass.
create function public.keep_an_owner(org uuid, losing uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = losing and m.role = 'owner'
  ) and not exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id <> losing and m.role = 'owner'
  ) then
    raise exception 'An organization needs an owner. Make someone else an owner first.'
      using errcode = 'NC016';
  end if;
end;
$$;

revoke execute on function public.keep_an_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.keep_an_owner(uuid, uuid) to service_role;

-- Refuses a twenty-first invitation waiting, so the email cannot be used to write to strangers.
create function public.room_to_invite(org uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (
    select count(*) from public.invitations i
    where i.organization_id = org and i.ended_at is null and i.expires_at > now()
  ) >= 20 then
    raise exception 'Twenty invitations are waiting already. Cancel one first.'
      using errcode = 'NC016';
  end if;
end;
$$;

revoke execute on function public.room_to_invite(uuid) from public, anon, authenticated;
grant execute on function public.room_to_invite(uuid) to service_role;

-- An owner invites an address as an admin or a member. Answers an owner of the organization and
-- no one else, the operator included. Refused for an address already in it or already invited,
-- one sent an invitation in the last hour, and past twenty waiting. A declined invitation to the
-- same address is replaced.
create function public.invite_member(org uuid, address text, as_role public.member_role)
returns setof public.invitations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  invited text := lower(btrim(coalesce(address, '')));
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;
  perform 1 from public.organizations o where o.id = org for update;
  if as_role not in ('admin', 'member') then
    raise exception 'Invite them as an admin or a member. Make them an owner once they have joined.'
      using errcode = 'NC016';
  end if;
  if invited not like '%_@_%' then
    raise exception 'That is not an email address.' using errcode = 'NC016';
  end if;
  if exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = org and lower(btrim(u.email)) = invited
  ) then
    raise exception 'They are already in this organization.' using errcode = 'NC016';
  end if;
  if exists (
    select 1 from public.invitations i
    where i.organization_id = org and i.email = invited and i.ended_at is null
  ) then
    raise exception 'That address is already invited. Send the invitation again instead.'
      using errcode = 'NC016';
  end if;
  -- Once an hour to an address, whatever became of the last: cancelling and inviting again is not
  -- a way to write to someone more often.
  if exists (
    select 1 from public.invitations i
    where i.organization_id = org and i.email = invited and i.sent_at > now() - interval '1 hour'
  ) then
    raise exception 'An invitation went to that address less than an hour ago. Try again later.'
      using errcode = 'NC016';
  end if;
  perform public.room_to_invite(org);

  update public.invitations
  set outcome = 'cancelled', ended_at = now()
  where organization_id = org and email = invited and outcome = 'declined';

  return query
    insert into public.invitations (organization_id, email, role, invited_by, invited_by_email)
    values (org, invited, as_role, caller, (select u.email from auth.users u where u.id = caller))
    returning *;
end;
$$;

revoke execute on function public.invite_member(uuid, text, public.member_role) from public, anon;
grant execute on function public.invite_member(uuid, text, public.member_role) to authenticated;

-- An owner sends an invitation again: it waits fourteen days from now, a declined or expired one
-- included. At most once an hour. Answers an owner of the organization and no one else.
create function public.send_invitation_again(org uuid, invitation uuid)
returns setof public.invitations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  kept public.invitations;
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;
  perform 1 from public.organizations o where o.id = org for update;
  select * into kept from public.invitations i
  where i.id = invitation and i.organization_id = org
    and (i.ended_at is null or i.outcome = 'declined')
  for update;
  if not found then
    return;
  end if;
  if kept.sent_at > now() - interval '1 hour' then
    raise exception 'It was sent less than an hour ago. Try again later.' using errcode = 'NC016';
  end if;
  -- One already waiting stays inside the twenty; one coming back must fit.
  if kept.ended_at is not null or kept.expires_at <= now() then
    perform public.room_to_invite(org);
  end if;

  return query
    update public.invitations
    set sent_at = now(), expires_at = now() + interval '14 days', ended_at = null, outcome = null,
        invited_by = caller,
        invited_by_email = (select u.email from auth.users u where u.id = caller)
    where id = invitation
    returning *;
end;
$$;

revoke execute on function public.send_invitation_again(uuid, uuid) from public, anon;
grant execute on function public.send_invitation_again(uuid, uuid) to authenticated;

-- An owner cancels an invitation that is waiting, or removes a declined or expired one from the
-- list. Answers an owner of the organization and no one else.
create function public.cancel_invitation(org uuid, invitation uuid)
returns setof public.invitations
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;
  return query
    update public.invitations
    set outcome = 'cancelled', ended_at = now()
    where id = invitation and organization_id = org
      and (ended_at is null or outcome = 'declined')
    returning *;
end;
$$;

revoke execute on function public.cancel_invitation(uuid, uuid) from public, anon;
grant execute on function public.cancel_invitation(uuid, uuid) to authenticated;

-- The invitations waiting for the signed-in person, with who sent each. Only their own address's,
-- unexpired, to an organization not being closed.
create function public.my_invitations()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  role public.member_role,
  invited_by_email text,
  expires_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select i.id, i.organization_id, o.name, i.role, i.invited_by_email, i.expires_at
  from public.invitations i
  join public.organizations o on o.id = i.organization_id
  where i.email = public.my_address()
    and i.ended_at is null
    and i.expires_at > now()
    and o.closing_at is null
  order by i.sent_at, i.id;
$$;

revoke execute on function public.my_invitations() from public, anon;
grant execute on function public.my_invitations() to authenticated;

-- The person invited accepts: they join with the invitation's role. Answers only someone signed
-- in with the address it was sent to. Refused once it has expired, for an organization being
-- closed, for an account with a platform role, and while they belong to another organization,
-- as create_organization() refuses a second.
create function public.accept_invitation(invitation uuid)
returns setof public.invitations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  kept public.invitations;
begin
  if caller is null then
    return;
  end if;
  select * into kept from public.invitations i
  where i.id = invitation and i.email = public.my_address() and i.ended_at is null
  for update;
  if not found then
    return;
  end if;
  if kept.expires_at <= now() then
    raise exception 'This invitation has expired. Ask for it to be sent again.'
      using errcode = 'NC016';
  end if;
  if exists (
    select 1 from public.organizations o where o.id = kept.organization_id and o.closing_at is not null
  ) then
    raise exception 'That organization is being closed.' using errcode = 'NC016';
  end if;
  -- The operator and a test account join nothing: the operator changes a customer's account
  -- only through its own functions, and a test account's organizations are never customers'.
  if exists (select 1 from public.platform_roles r where r.user_id = caller) then
    raise exception 'This account cannot join an organization.' using errcode = 'NC016';
  end if;
  if exists (select 1 from public.memberships m where m.user_id = caller) then
    raise exception 'You already belong to an organization. Leave it, or close it, before joining another.'
      using errcode = 'NC016';
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (kept.organization_id, caller, kept.role);

  return query
    update public.invitations set outcome = 'accepted', ended_at = now()
    where id = invitation
    returning *;
end;
$$;

revoke execute on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

-- The person invited declines. Answers only someone signed in with the address it was sent to,
-- for one still waiting, to an organization not being closed.
create function public.decline_invitation(invitation uuid)
returns setof public.invitations
language plpgsql security definer set search_path = ''
as $$
begin
  return query
    update public.invitations i set outcome = 'declined', ended_at = now()
    where i.id = invitation and i.email = public.my_address() and i.ended_at is null
      and i.expires_at > now()
      and exists (
        select 1 from public.organizations o
        where o.id = i.organization_id and o.closing_at is null
      )
    returning i.*;
end;
$$;

revoke execute on function public.decline_invitation(uuid) from public, anon;
grant execute on function public.decline_invitation(uuid) to authenticated;

-- An owner gives a member another role, owner included. Answers an owner of the organization and
-- no one else, the operator included. Refused where it would leave the organization no owner.
create function public.change_member_role(org uuid, member uuid, to_role public.member_role)
returns setof public.memberships
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;
  perform 1 from public.organizations o where o.id = org for update;
  if to_role <> 'owner' then
    perform public.keep_an_owner(org, member);
  end if;
  return query
    update public.memberships set role = to_role
    where organization_id = org and user_id = member
    returning *;
end;
$$;

revoke execute on function public.change_member_role(uuid, uuid, public.member_role)
  from public, anon;
grant execute on function public.change_member_role(uuid, uuid, public.member_role)
  to authenticated;

-- An owner removes someone, themselves included where another owner stays. Answers an owner of
-- the organization and no one else. Their sign-in is theirs and stays.
create function public.remove_member(org uuid, member uuid)
returns setof public.memberships
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_org_role(org, array['owner']::public.member_role[]) then
    return;
  end if;
  perform 1 from public.organizations o where o.id = org for update;
  perform public.keep_an_owner(org, member);
  return query
    delete from public.memberships where organization_id = org and user_id = member
    returning *;
end;
$$;

revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

-- Anyone in an organization leaves it, but its last owner.
create function public.leave_organization(org uuid)
returns setof public.memberships
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not public.is_org_member(org) then
    return;
  end if;
  perform 1 from public.organizations o where o.id = org for update;
  perform public.keep_an_owner(org, caller);
  return query
    delete from public.memberships where organization_id = org and user_id = caller
    returning *;
end;
$$;

revoke execute on function public.leave_organization(uuid) from public, anon;
grant execute on function public.leave_organization(uuid) to authenticated;

-- The caller's own role in each of their organizations, as my_organizations() lists them.
create function public.my_roles()
returns table (organization_id uuid, role public.member_role)
language sql stable security definer set search_path = ''
as $$
  select m.organization_id, m.role
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid()) and o.closing_at is null
  order by m.organization_id;
$$;

revoke execute on function public.my_roles() from public, anon;
grant execute on function public.my_roles() to authenticated;

-- Who is in an organization: each person's address, role and when they joined. Answers a member
-- of it and the operator; empty for anyone else. The addresses are in the sign-in records, which
-- no API role reads.
create function public.organization_members(org uuid)
returns table (user_id uuid, email text, role public.member_role, joined_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, u.email, m.role, m.created_at
  from public.memberships m
  left join auth.users u on u.id = m.user_id
  where m.organization_id = org
    and (public.is_org_member(org) or (select public.is_operator()))
  order by m.role, m.created_at, u.email;
$$;

revoke execute on function public.organization_members(uuid) from public, anon;
grant execute on function public.organization_members(uuid) to authenticated;

-- export_organization() carries the organization's invitations. Otherwise as before.
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
    'invitations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select i.id, i.organization_id, i.email, i.role, i.invited_by_email, i.created_at,
          i.sent_at, i.expires_at, i.ended_at, i.outcome
        from public.invitations i where i.organization_id = o.id
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
