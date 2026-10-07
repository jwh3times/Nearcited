-- Shareable audits for a business that has not signed up (issue #5).
--
-- An audit is a one-off report: a business, a handful of prompts, and each prompt asked several
-- times on each assistant. It belongs to no organization and no user. The owner of the product
-- creates one with the secret key, and anyone holding its link can read it.

create type public.audit_status as enum ('queued', 'ready', 'failed');

create table public.audits (
  id uuid primary key default gen_random_uuid(),
  -- The unguessable part of the link: 64 hex characters from two random UUIDs.
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  business_name text not null check (char_length(business_name) between 1 and 120),
  website text check (website is null or char_length(website) <= 200),
  city text not null check (char_length(city) between 1 and 80),
  region text check (region is null or char_length(region) <= 80),
  country_code text not null default 'US' check (char_length(country_code) = 2),
  prompts text[] not null check (cardinality(prompts) between 1 and 5),
  -- How many times each prompt is asked on each assistant.
  samples integer not null default 5 check (samples between 1 and 5),
  status public.audit_status not null default 'queued',
  -- One entry per prompt, keyed by its position in `prompts`, written as each finishes.
  parts jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz
);

-- Nobody reaches the table through the API roles. The worker and the owner's script use the
-- secret key; readers go through get_audit() below.
alter table public.audits enable row level security;
revoke all on public.audits from anon, authenticated;
grant all on public.audits to service_role;

-- Stores one prompt's results. The audit becomes ready when every prompt has reported, and goes
-- back to queued if an earlier attempt had marked it failed and a retry has now succeeded.
create function public.record_audit_part(p_audit_id uuid, p_index integer, p_part jsonb)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_parts jsonb;
  v_prompts integer;
begin
  update public.audits
  set parts = parts || jsonb_build_object(p_index::text, p_part)
  where id = p_audit_id
  returning parts, cardinality(prompts) into v_parts, v_prompts;

  if v_parts is null then
    raise exception 'audit % not found', p_audit_id using errcode = 'P0002';
  end if;

  update public.audits
  set status = case
        when (select count(*) from jsonb_object_keys(v_parts)) >= v_prompts
          then 'ready'::public.audit_status
        else 'queued'::public.audit_status
      end,
      error = null
  where id = p_audit_id;
end;
$$;

-- The only way a reader sees an audit: by its token, while it is neither revoked nor expired.
-- SECURITY DEFINER so it can read a table the caller cannot; it returns only what the page shows.
create function public.get_audit(p_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'business_name', a.business_name,
    'website', a.website,
    'city', a.city,
    'region', a.region,
    'prompts', to_jsonb(a.prompts),
    'samples', a.samples,
    'status', a.status,
    'parts', a.parts,
    'created_at', a.created_at,
    'expires_at', a.expires_at
  )
  from public.audits a
  where a.token = p_token
    and a.revoked_at is null
    and a.expires_at > now();
$$;

revoke execute on function
  public.record_audit_part(uuid, integer, jsonb),
  public.get_audit(text)
from public, anon, authenticated;

grant execute on function public.record_audit_part(uuid, integer, jsonb) to service_role;
grant execute on function public.get_audit(text) to anon, authenticated, service_role;
