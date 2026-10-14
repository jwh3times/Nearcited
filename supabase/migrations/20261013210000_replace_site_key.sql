-- Replacing a location's site key (issue #139,
-- docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md).
--
-- The key is in the source of the business's site, so anyone can read it and post made-up
-- visits under it. Replacing it is what an owner does about that. The old key then belongs to
-- nobody, the line on the site counts nothing until it is pasted again with the new one, and
-- what was counted so far stays, since a count is kept for the location and not for the key.
--
-- The Worker deployed before this migration does not call the function.

-- An owner or an admin gives a location a new key. Answers nobody else: for a member, the
-- operator and the worker, no row and nothing changed. A new key has answered no check.
create function public.replace_site_key(location uuid)
returns setof public.visit_lines
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_org_role(
    (select l.organization_id from public.locations l where l.id = location),
    array['owner', 'admin']::public.member_role[])
  then
    return;
  end if;

  return query
  update public.visit_lines v
  set key = public.new_site_key(), key_made_at = now(), checked_on = null
  where v.location_id = location
  returning v.*;
end;
$$;

revoke execute on function public.replace_site_key(uuid) from public, anon;
grant execute on function public.replace_site_key(uuid) to authenticated;
