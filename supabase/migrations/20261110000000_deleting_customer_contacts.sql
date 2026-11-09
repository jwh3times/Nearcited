-- Deleting customer contacts once they are no longer needed (issue #294, part of #146,
-- docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md).
--
-- Nothing readable about a customer outlives its use. The daily run deletes a contact thirty days
-- after its request was sent, and one whose request ended unsent once the week after the job is
-- over.
--
-- What remains are the fingerprints: whom the organization asked, who opted out of it, and which
-- addresses bounced hard or complained. They are kept, so turning review requests on again asks
-- nobody twice.
--
-- The Worker deployed before this migration keeps working: it does not call the new function.

-- Deletes every contact whose request was sent thirty days ago or more, and every one whose
-- request ended unsent (declined, lapsed or failed) once the week after the job is over, when it
-- can no longer be asked for again. A request asked for again is a new action for the same
-- contact, with the same week. Returns how many. The requests stay, with nothing of the
-- customer's. Worker only: the daily run calls it.
create function public.drop_spent_contacts()
returns integer
language sql security definer set search_path = ''
as $$
  with dropped as (
    delete from public.customer_contacts c
    where exists (
        select 1 from public.actions a
        where a.contact_id = c.id and (a.status = 'done' or a.lapses_at <= now())
      )
      and not exists (
        select 1 from public.actions a
        where a.contact_id = c.id
          and (
            a.status in ('proposed', 'approved')
            or (a.status = 'done' and a.done_at > now() - interval '30 days')
          )
      )
    returning 1
  )
  select count(*)::integer from dropped;
$$;

revoke execute on function public.drop_spent_contacts() from public, anon, authenticated;
grant execute on function public.drop_spent_contacts() to service_role;

-- A request that was waiting when its location's review requests stopped lapses as `turned_off`.
alter table public.actions drop constraint actions_lapse_reason_check;
alter table public.actions add constraint actions_lapse_reason_check
  check (lapse_reason in ('expired', 'out_of_date', 'turned_off'));

-- When a location's review requests stop, whether an owner or admin turned them off, the plan
-- stopped including them (fit_connections_to_plan() pauses the connection) or the location is
-- deleted, then at once:
--   every request of theirs still waiting, for a yes or for its morning, lapses, and the month is
--     given back what one already took;
--   every contact of the location is deleted, sent or not.
-- A request being carried out right now is left to finish: with its contact gone it is not sent.
-- The receipt address stops receiving on its own: receive_receipt() drops what reaches a
-- connection that is paused or being removed.
create function public.stop_review_requests()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  took date;
begin
  for took in
    update public.actions x
    set status = 'lapsed', lapsed_at = now(), lapse_reason = 'turned_off', due_at = null,
        allowance_month = null
    from public.actions was
    where was.id = x.id
      and x.connection_id = new.id
      and x.kind = 'review_request'
      and (x.status = 'proposed' or (x.status = 'approved' and x.carrying_since is null))
    returning was.allowance_month
  loop
    if took is not null then
      perform public.release_allowance(
        new.organization_id,
        (select t.allowance from public.action_kind_terms t where t.kind = 'review_request'),
        took
      );
    end if;
  end loop;

  delete from public.customer_contacts c
  using public.review_request_settings s
  where s.connection_id = new.id and c.location_id = s.location_id;
  return new;
end;
$$;

revoke execute on function public.stop_review_requests() from public, anon, authenticated;

create trigger stop_review_requests
  after update of status on public.connections
  for each row
  when (
    new.kind = 'review_requests'
    and new.status in ('paused', 'removing', 'removed')
    and old.status not in ('paused', 'removing', 'removed')
  )
  execute function public.stop_review_requests();
