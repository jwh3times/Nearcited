-- Who has signed up, for the operator (docs/adr/0004-the-operator-reads-through-policies.md).
--
-- Sign-up and last sign-in times live in auth.users, which no API role may read. The operator's
-- view of accounts goes through this one function, which answers the operator and nobody else and
-- returns only what the view shows.

create function public.operator_accounts()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where (select public.is_operator())
  order by u.created_at desc;
$$;

revoke execute on function public.operator_accounts() from public, anon;
grant execute on function public.operator_accounts() to authenticated;
