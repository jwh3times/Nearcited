-- The operator makes a shareable audit (docs/adr/0005-the-operator-changes-limits-through-one-function.md).
--
-- Until now an audit could be made only by the owner's script, with the secret key. This is the
-- second thing the operator may change, and it follows the first: one function that answers the
-- operator and nobody else, does one thing, and writes down that it did it. The `audits` table
-- stays closed to every API role's writes, and the columns' own checks still bound every value.
--
-- Returns the new audit, or no row for anyone but the operator. Nothing is asked of any assistant
-- here: the caller puts one message per prompt on the queue, as the script does.

create function public.operator_create_audit(
  p_business_name text,
  p_website text,
  p_city text,
  p_region text,
  p_country_code text,
  p_prompts text[],
  p_samples integer
)
returns setof public.audits
language plpgsql security definer set search_path = ''
as $$
declare
  made public.audits;
begin
  if not (select public.is_operator()) then
    return;
  end if;

  insert into public.audits (business_name, website, city, region, country_code, prompts, samples)
  values (p_business_name, p_website, p_city, p_region, p_country_code, p_prompts, p_samples)
  returning * into made;

  insert into public.operator_actions (actor_id, action, detail)
  values (
    (select auth.uid()),
    'create_audit',
    jsonb_build_object(
      'audit_id', made.id,
      'business_name', made.business_name,
      'prompts', cardinality(made.prompts),
      'samples', made.samples
    )
  );

  return next made;
end;
$$;

revoke execute on function public.operator_create_audit(text, text, text, text, text, text[], integer)
  from public, anon;
grant execute on function public.operator_create_audit(text, text, text, text, text, text[], integer)
  to authenticated;
