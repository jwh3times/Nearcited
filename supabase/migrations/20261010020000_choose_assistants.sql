-- An owner chooses which assistants their organization is checked on (issue #9).
--
-- A plan says how many assistants its scans ask. When that is fewer than are offered, the
-- organization's owner picks which, and may change the pick later. Like the limits, `surfaces`
-- is not a column a member can update, so the choice goes through this function, which checks
-- it against the plan.
--
-- Returns the organization, or no row for anyone who is not its owner. Past results are kept:
-- a score is worked out per assistant, so a newly chosen one starts with nothing behind it.

create function public.choose_assistants(org uuid, chosen public.surface[])
returns setof public.organizations
language plpgsql security definer set search_path = ''
as $$
declare
  allowed integer;
  picked public.surface[];
begin
  if not exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = (select auth.uid()) and m.role = 'owner'
  ) then
    return;
  end if;

  select p.assistants into allowed
  from public.organizations o
  join public.plans p on p.key = o.plan_key
  where o.id = org
  for update of o;

  if not found then
    raise exception 'This organization''s assistants were set for it and cannot be changed here.'
      using errcode = 'NC004';
  end if;

  -- In a fixed order and without repeats, whatever order they were sent in.
  select coalesce(array_agg(s order by s), '{}') into picked
  from (select distinct unnest(chosen) as s) given;

  if not (picked <@ array['chatgpt', 'claude']::public.surface[]) then
    raise exception 'Choose from ChatGPT and Claude.' using errcode = 'NC004';
  end if;
  if cardinality(picked) <> least(allowed, 2) then
    raise exception 'This organization''s plan checks % %. Choose exactly that many.',
      least(allowed, 2), case when least(allowed, 2) = 1 then 'assistant' else 'assistants' end
      using errcode = 'NC004';
  end if;

  return query
    update public.organizations o set surfaces = picked where o.id = org returning o.*;
end;
$$;

revoke execute on function public.choose_assistants(uuid, public.surface[]) from public, anon;
grant execute on function public.choose_assistants(uuid, public.surface[]) to authenticated;
