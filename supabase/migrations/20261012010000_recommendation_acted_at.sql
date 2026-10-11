-- When a member said they did the work a recommendation points at.
--
-- `status` cannot hold this. It says whether the rule still fires: complete_scan() reopens a row
-- marked done while its rule fires and closes one whose rule has stopped. The day the work was
-- done has to outlive both, because the page sets the scans before that day beside the scans
-- since (docs/adr/0010-the-product-drafts-and-the-owner-acts.md). complete_scan() never names
-- this column, so no scan changes it.

alter table public.recommendations add column acted_at timestamptz;

-- Members may already update a recommendation's status, under the same policy. This adds one
-- more column to what that update may name.
grant update (acted_at) on public.recommendations to authenticated;

-- The time is the database's. A request says only that the work was done, or that it was not:
-- whatever time it sends is replaced, so nobody can move the line the before and after are
-- counted from.
create function public.stamp_recommendation_acted()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.acted_at is not null and new.acted_at is distinct from old.acted_at then
    new.acted_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.stamp_recommendation_acted() from public, anon, authenticated;

create trigger recommendations_stamp_acted
  before update of acted_at on public.recommendations
  for each row execute function public.stamp_recommendation_acted();
