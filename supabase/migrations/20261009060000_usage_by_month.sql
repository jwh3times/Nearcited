-- What was used at the providers, added up by calendar month, for the operator's spend figures.
--
-- A row of provider_usage is one scan's use of one model, so a month holds thousands of them and
-- the API would hand back only the first page. This adds them up in the database: one row per
-- month (in UTC), organization, model and whether it was an audit. It holds no price; counts
-- become money on the server.
--
-- It runs as the caller, so the table's own policy decides what is counted: everything for the
-- operator and the worker, nothing for anyone else.

create function public.usage_by_month(since timestamptz)
returns table (
  month text,
  organization_id uuid,
  is_audit boolean,
  model text,
  calls bigint,
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  searches bigint
)
language sql stable security invoker set search_path = ''
as $$
  select
    to_char(u.created_at at time zone 'UTC', 'YYYY-MM'),
    u.organization_id,
    u.audit_id is not null,
    u.model,
    sum(u.calls),
    sum(u.input_tokens),
    sum(u.cached_input_tokens),
    sum(u.output_tokens),
    sum(u.searches)
  from public.provider_usage u
  where u.created_at >= since
  group by 1, 2, 3, 4;
$$;

revoke execute on function public.usage_by_month(timestamptz) from public, anon;
grant execute on function public.usage_by_month(timestamptz) to authenticated, service_role;
