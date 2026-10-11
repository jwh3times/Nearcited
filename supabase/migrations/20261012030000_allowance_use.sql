-- Counting what an allowance is used for (issue #133,
-- docs/adr/0012-a-plans-allowances-are-one-set.md).
--
-- A counted kind of allowance is a number a month for each location a plan covers, shared across
-- the organization. This is where a month's use is kept, and the one function that adds to it.
-- Nothing calls it yet: the first kind of work that is counted will.
--
-- The Worker deployed before this migration is not touched by it: it reads neither the table nor
-- the function.

create table public.allowance_use (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null references public.allowance_kinds (key),
  -- The calendar month (UTC) the count is for, as its first day.
  month date not null check (extract(day from month) = 1),
  used integer not null default 0 check (used >= 0),
  primary key (organization_id, kind, month)
);

comment on table public.allowance_use is
  'How much of each counted allowance an organization has used in a calendar month (UTC). Written only by claim_allowance().';

-- An organization's members read its use, and the operator reads everyone's. No API role writes
-- it: a count a member could write is a count a member could clear.
alter table public.allowance_use enable row level security;
revoke all on public.allowance_use from public, anon, authenticated;
grant select on public.allowance_use to authenticated;
grant all on public.allowance_use to service_role;

create policy "Members read their organization's use of its allowances"
  on public.allowance_use for select to authenticated
  using (public.is_org_member(organization_id));

create policy "The operator reads use of allowances"
  on public.allowance_use for select to authenticated
  using ((select public.is_operator()));

-- Takes `amount` of one kind from an organization's month, if its allowance has room, and says
-- what happened:
--
--   claimed  false when the kind is not included, or the month's number would be passed. Nothing
--            is counted then.
--   allowed  the month's number: the plan's number for each location it covers, extra ones
--            included. Null for a kind that is included without a number, 0 for one that is not
--            included.
--   used     how much of the month is used, after this.
--
-- No row for an organization that does not exist.
--
-- Worker only. Work a member starts is counted by the function that does the work, which calls
-- this as its owner, so nobody can use up an allowance without the work being done.
create function public.claim_allowance(org uuid, of_kind text, amount integer default 1)
returns table (claimed boolean, allowed integer, used integer)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  o public.organizations;
  allowance jsonb;
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
  most integer;
  so_far integer;
begin
  if amount is null or amount < 1 then
    raise exception 'An allowance is claimed one or more at a time.' using errcode = '22023';
  end if;

  -- The organization's row is locked, so two claims at once cannot both take the last one.
  select * into o from public.organizations where id = org for update;
  if not found then
    return;
  end if;

  allowance := o.allowances -> of_kind;
  if allowance is null then
    return query select false, 0, 0;
    return;
  end if;
  if allowance = 'true'::jsonb then
    return query select true, null::integer, 0;
    return;
  end if;

  most := (allowance #>> '{}')::integer * o.max_locations;
  select coalesce(sum(u.used), 0)::integer into so_far
  from public.allowance_use u
  where u.organization_id = org and u.kind = of_kind and u.month = this_month;

  if so_far + amount > most then
    return query select false, most, so_far;
    return;
  end if;

  insert into public.allowance_use as u (organization_id, kind, month, used)
  values (org, of_kind, this_month, amount)
  on conflict (organization_id, kind, month) do update set used = u.used + excluded.used;

  return query select true, most, so_far + amount;
end;
$$;

revoke execute on function public.claim_allowance(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_allowance(uuid, text, integer) to service_role;
