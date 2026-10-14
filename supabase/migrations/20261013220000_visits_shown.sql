-- Visits from assistants, shown and on the plans (issue #139,
-- docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md).
--
-- A location's site reports its visits from assistants and the product counts them. Two things
-- were missing: a way to read the counts added up, and a plan that includes them.
--
-- The counts are read added up, never row by row. A location can hold up to 255 rows a day
-- (five assistants under fifty pages and the rest), which is past what the database's API
-- answers in one request, and a page only ever shows them by day and by page.
--
-- Visits go on the four paid plans, and an organization already on one of those is given it
-- now, as it would be if the operator had set it: a plan gaining something takes effect at
-- once. Only this one kind is touched, so limits the operator set for one organization stay as
-- they are. The free plan has none. A test organization has had the kind since it was made.
--
-- The Worker deployed before this migration keeps working. It counts nothing for an
-- organization without the allowance and starts to for one with it, as it would after the
-- operator gave it. It does not call the function, and its price list has no words for the
-- kind, so it leaves it out.

-- A location's visits over the last `over_days` days (UTC), today included, added up: by day
-- and assistant, by page for the ten pages with the most, and the visits to pages past the
-- fiftieth of their day. The days are this function's own to count back from. Runs as the
-- caller, so it adds up only the rows the caller may read: a member's own, or the operator's
-- everything. For anyone else there is nothing to add up.
create function public.location_visits(location uuid, over_days integer)
returns jsonb
language sql stable set search_path = ''
as $$
  with bounds as (
    select (now() at time zone 'UTC')::date - (greatest(least(over_days, 366), 1) - 1) as since
  ),
  counted as (
    select v.day, v.assistant, v.path, v.count
    from public.visits v, bounds b
    where v.location_id = location and v.day >= b.since
  )
  select jsonb_build_object(
    'since', (select b.since from bounds b),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'assistant', d.assistant, 'count', d.count)
                       order by d.day, d.assistant)
      from (
        select c.day, c.assistant, sum(c.count)::integer as count
        from counted c
        group by c.day, c.assistant
      ) d), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object('path', p.path, 'count', p.count)
                       order by p.count desc, p.path)
      from (
        select c.path, sum(c.count)::integer as count
        from counted c
        where c.path <> ''
        group by c.path
        order by sum(c.count) desc, c.path
        limit 10
      ) p), '[]'::jsonb),
    'other_pages', (select coalesce(sum(c.count), 0)::integer from counted c where c.path = '')
  );
$$;

revoke execute on function public.location_visits(uuid, integer) from public, anon;
grant execute on function public.location_visits(uuid, integer) to authenticated, service_role;

update public.plans p
set allowances = p.allowances || jsonb_build_object('visits', true),
    updated_at = now()
where p.key in ('starter', 'standard', 'pro', 'enterprise');

update public.organizations o
set allowances = o.allowances || jsonb_build_object('visits', true)
from public.plans p
where p.key = o.plan_key
  and p.allowances ? 'visits'
  and not o.is_test;
