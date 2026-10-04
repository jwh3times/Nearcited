-- Nearcited initial schema.
--
-- Tenancy model: every row hangs off an organization, and a user sees a row only through a
-- membership in that organization. The API talks to Postgres as the signed-in user, so these
-- policies are the real authorization layer, not a backstop behind application checks.
-- The scan worker uses the secret key, which bypasses row-level security.

create type public.member_role as enum ('owner', 'admin', 'member');
create type public.query_kind as enum ('ai_prompt', 'search_keyword');
create type public.surface as enum (
  'chatgpt', 'gemini', 'perplexity', 'claude',
  'google_ai_overview', 'google_local_pack', 'google_organic'
);
create type public.scan_status as enum ('queued', 'running', 'succeeded', 'failed');
create type public.scan_trigger as enum ('manual', 'scheduled');
create type public.scan_frequency as enum ('off', 'weekly', 'daily');
create type public.recommendation_status as enum ('open', 'done', 'dismissed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  website text check (char_length(website) <= 200),
  phone text check (char_length(phone) <= 40),
  address_line text check (char_length(address_line) <= 200),
  city text not null check (char_length(city) between 1 and 80),
  region text check (char_length(region) <= 80),
  postal_code text check (char_length(postal_code) <= 20),
  country_code text not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  google_place_id text check (char_length(google_place_id) <= 200),
  primary_category text check (char_length(primary_category) <= 120),
  scan_frequency public.scan_frequency not null default 'weekly',
  last_scanned_at timestamptz,
  created_at timestamptz not null default now()
);
create index locations_organization_id_idx on public.locations (organization_id);

create table public.tracked_queries (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  kind public.query_kind not null,
  text text not null check (char_length(text) between 1 and 300),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (location_id, kind, text)
);

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  status public.scan_status not null default 'queued',
  trigger public.scan_trigger not null,
  requested_by uuid references auth.users (id) on delete set null,
  visibility_score numeric(4, 1) check (visibility_score between 0 and 100),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index scans_location_created_idx on public.scans (location_id, created_at desc);

create table public.scan_results (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,
  tracked_query_id uuid not null references public.tracked_queries (id) on delete cascade,
  surface public.surface not null,
  mentioned boolean not null,
  "position" integer check ("position" > 0),
  competitors jsonb not null default '[]'::jsonb,
  cited_urls jsonb not null default '[]'::jsonb,
  answer_excerpt text,
  sampled_at timestamptz not null default now(),
  unique (scan_id, tracked_query_id, surface)
);
create index scan_results_tracked_query_id_idx on public.scan_results (tracked_query_id);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  scan_id uuid references public.scans (id) on delete set null,
  rule text not null,
  title text not null,
  detail text not null,
  status public.recommendation_status not null default 'open',
  created_at timestamptz not null default now(),
  unique (location_id, rule)
);

-- ---------------------------------------------------------------------------
-- Access helpers
--
-- SECURITY DEFINER so a policy can ask "is this user a member?" without that question being
-- filtered by the policies on memberships itself (which would recurse). Each one is pinned to an
-- empty search_path and only ever answers about the calling user.
-- ---------------------------------------------------------------------------

create function public.is_org_member(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = (select auth.uid())
  );
$$;

create function public.has_org_role(org uuid, roles public.member_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.role = any (roles)
  );
$$;

create function public.can_access_location(loc uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.locations l
    join public.memberships m on m.organization_id = l.organization_id
    where l.id = loc and m.user_id = (select auth.uid())
  );
$$;

create function public.can_access_scan(scan uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.scans s
    join public.locations l on l.id = s.location_id
    join public.memberships m on m.organization_id = l.organization_id
    where s.id = scan and m.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Operations that need more than one statement
-- ---------------------------------------------------------------------------

-- Creating an organization also makes the caller its owner. There is no INSERT policy on
-- organizations or a self-service one on memberships, so this function is the only way in.
create function public.create_organization(org_name text)
returns public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  org public.organizations;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.organizations (name, created_by)
  values (btrim(org_name), caller)
  returning * into org;

  insert into public.memberships (organization_id, user_id, role)
  values (org.id, caller, 'owner');

  return org;
end;
$$;

-- Worker only. Writes a finished scan in one transaction: results, score, the location's
-- last-scanned time, and the recommendations that scan produced.
create function public.complete_scan(
  p_scan_id uuid,
  p_score numeric,
  p_results jsonb,
  p_recommendations jsonb
)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_location uuid;
begin
  update public.scans
  set status = 'succeeded', visibility_score = p_score, error = null, finished_at = now()
  where id = p_scan_id
  returning location_id into v_location;

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
end;
$$;

-- Worker only. Locations whose schedule says they are due, skipping any with nothing to check
-- or with a scan already in flight.
create function public.locations_due_for_scan(max_rows integer default 100)
returns setof uuid
language sql stable set search_path = ''
as $$
  select l.id
  from public.locations l
  where exists (
      select 1 from public.tracked_queries q where q.location_id = l.id and q.is_active
    )
    and not exists (
      select 1 from public.scans s
      where s.location_id = l.id
        and s.status in ('queued', 'running')
        and s.created_at > now() - interval '6 hours'
    )
    and (
      (l.scan_frequency = 'daily'
        and (l.last_scanned_at is null or l.last_scanned_at < now() - interval '20 hours'))
      or
      (l.scan_frequency = 'weekly'
        and (l.last_scanned_at is null or l.last_scanned_at < now() - interval '6 days 12 hours'))
    )
  order by l.last_scanned_at asc nulls first
  limit max_rows;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Stated explicitly rather than relying on the project's default grants: signed-out visitors
-- get nothing, signed-in users get exactly what the policies below are written for, and the
-- worker-only functions are not callable through the public API.
-- ---------------------------------------------------------------------------

revoke all on
  public.organizations, public.memberships, public.locations, public.tracked_queries,
  public.scans, public.scan_results, public.recommendations
from anon, authenticated;

grant select, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
grant select, insert, update, delete on public.locations to authenticated;
grant select, insert, update, delete on public.tracked_queries to authenticated;
grant select, insert on public.scans to authenticated;
grant select on public.scan_results to authenticated;
grant select on public.recommendations to authenticated;
grant update (status) on public.recommendations to authenticated;

grant all on
  public.organizations, public.memberships, public.locations, public.tracked_queries,
  public.scans, public.scan_results, public.recommendations
to service_role;

revoke execute on function
  public.is_org_member(uuid),
  public.has_org_role(uuid, public.member_role[]),
  public.can_access_location(uuid),
  public.can_access_scan(uuid),
  public.create_organization(text),
  public.complete_scan(uuid, numeric, jsonb, jsonb),
  public.locations_due_for_scan(integer)
from public, anon, authenticated;

grant execute on function
  public.is_org_member(uuid),
  public.has_org_role(uuid, public.member_role[]),
  public.can_access_location(uuid),
  public.can_access_scan(uuid),
  public.create_organization(text)
to authenticated;

grant execute on function
  public.complete_scan(uuid, numeric, jsonb, jsonb),
  public.locations_due_for_scan(integer)
to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.locations enable row level security;
alter table public.tracked_queries enable row level security;
alter table public.scans enable row level security;
alter table public.scan_results enable row level security;
alter table public.recommendations enable row level security;

-- organizations: created only through create_organization().
create policy "Members read their organizations"
  on public.organizations for select to authenticated
  using (public.is_org_member(id));

create policy "Owners and admins update their organization"
  on public.organizations for update to authenticated
  using (public.has_org_role(id, array['owner', 'admin']::public.member_role[]))
  with check (public.has_org_role(id, array['owner', 'admin']::public.member_role[]));

create policy "Owners delete their organization"
  on public.organizations for delete to authenticated
  using (public.has_org_role(id, array['owner']::public.member_role[]));

-- memberships: only owners change who belongs, so an admin cannot promote themselves.
create policy "Members read their organization's memberships"
  on public.memberships for select to authenticated
  using (public.is_org_member(organization_id));

create policy "Owners add members"
  on public.memberships for insert to authenticated
  with check (public.has_org_role(organization_id, array['owner']::public.member_role[]));

create policy "Owners change member roles"
  on public.memberships for update to authenticated
  using (public.has_org_role(organization_id, array['owner']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner']::public.member_role[]));

create policy "Owners remove members"
  on public.memberships for delete to authenticated
  using (public.has_org_role(organization_id, array['owner']::public.member_role[]));

-- locations
create policy "Members read locations"
  on public.locations for select to authenticated
  using (public.is_org_member(organization_id));

create policy "Members add locations"
  on public.locations for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members update locations"
  on public.locations for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "Members delete locations"
  on public.locations for delete to authenticated
  using (public.is_org_member(organization_id));

-- tracked_queries
create policy "Members read tracked queries"
  on public.tracked_queries for select to authenticated
  using (public.can_access_location(location_id));

create policy "Members add tracked queries"
  on public.tracked_queries for insert to authenticated
  with check (public.can_access_location(location_id));

create policy "Members update tracked queries"
  on public.tracked_queries for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

create policy "Members delete tracked queries"
  on public.tracked_queries for delete to authenticated
  using (public.can_access_location(location_id));

-- scans: a user may only queue a manual scan as themselves. Everything after that is the worker's.
create policy "Members read scans"
  on public.scans for select to authenticated
  using (public.can_access_location(location_id));

create policy "Members queue manual scans"
  on public.scans for insert to authenticated
  with check (
    public.can_access_location(location_id)
    and trigger = 'manual'
    and status = 'queued'
    and requested_by = (select auth.uid())
    and visibility_score is null
    and error is null
    and started_at is null
    and finished_at is null
  );

-- scan_results: written by the worker, read by members.
create policy "Members read scan results"
  on public.scan_results for select to authenticated
  using (public.can_access_scan(scan_id));

-- recommendations: written by the worker; members may change status only (column grant above).
create policy "Members read recommendations"
  on public.recommendations for select to authenticated
  using (public.can_access_location(location_id));

create policy "Members update recommendation status"
  on public.recommendations for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
