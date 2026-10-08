-- What each scan and each audit used at the providers, so spend can be shown later.
--
-- One row per scan (or audit prompt) per surface per model: the counts the provider reported,
-- added up over that scan's calls. It holds no price. Rows outlive what they describe: deleting
-- a location deletes its scans, but the money was still spent, so the row stays and only loses
-- its link.

create table public.provider_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Null for an audit, which belongs to no organization, and once an organization is deleted.
  organization_id uuid references public.organizations (id) on delete set null,
  scan_id uuid references public.scans (id) on delete set null,
  audit_id uuid references public.audits (id) on delete set null,
  surface public.surface not null,
  model text not null check (char_length(model) between 1 and 120),
  calls integer not null check (calls > 0),
  input_tokens integer not null check (input_tokens >= 0),
  cached_input_tokens integer not null check (cached_input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  searches integer not null check (searches >= 0)
);

comment on table public.provider_usage is
  'What scans and audits used at the providers. Written by the worker. No API role reads it.';

-- Spend is read by month, for one organization or for all of them.
create index provider_usage_created_at on public.provider_usage (created_at);
create index provider_usage_organization on public.provider_usage (organization_id, created_at);

-- Closed to every API role: what a customer's scans cost is the operator's business, not a
-- member's. The worker writes it with the secret key.
alter table public.provider_usage enable row level security;
revoke all on public.provider_usage from anon, authenticated;
grant all on public.provider_usage to service_role;
