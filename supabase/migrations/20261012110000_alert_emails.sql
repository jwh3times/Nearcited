-- Telling an organization's owners about an alert (issue #136,
-- docs/adr/0015-an-alert-is-kept-not-worked-out-again.md).
--
-- An alert is told once, in the report a scheduled scan sends, where the organization's plan
-- emails that report. A drop the owners were told of is also told once when it ends because the
-- business was named again. These two columns are how the worker knows what it has said.
--
-- The Worker deployed before this migration reads neither column and goes on working.

alter table public.alerts
  add column told_at timestamptz,
  add column cleared_told_at timestamptz;

comment on column public.alerts.told_at is
  'When the organization''s owners were emailed that it was raised. Null until they are.';
comment on column public.alerts.cleared_told_at is
  'When the owners were emailed that it had ended. Only for one they were told of to begin with.';

-- What is still to tell is asked for at every scheduled scan.
create index alerts_untold on public.alerts (location_id)
  where told_at is null or cleared_told_at is null;
