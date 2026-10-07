-- Prompts are retired, not deleted (issue #37).
--
-- Deleting a tracked query cascades to every result recorded for it, which throws away the
-- history that rates over recent scans are counted from. A member now retires a prompt by
-- setting is_active to false, which the existing update policy already allows, and can no longer
-- delete the row. Deleting the location still removes its prompts and results.

drop policy "Members delete tracked queries" on public.tracked_queries;
revoke delete on public.tracked_queries from authenticated;
