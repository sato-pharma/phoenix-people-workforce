-- Fix: coaching report submission has been broken for every coach since the
-- 20260619054913_coaching_score_zero_submit_rpc migration.
--
-- That migration was meant to replace public.submit_coaching_report(uuid, text,
-- jsonb, text, text, text) [original 20260602194402 signature] with a new
-- signature (uuid, text, text, text, text, jsonb). Its own `drop function if
-- exists` for the old signature did not remove it in production, so both
-- overloads still exist side by side, both granted execute to service_role.
--
-- supabase-js's `.rpc()` always calls Postgres functions using all-named
-- parameters (via PostgREST), never positional. Both overloads accept the
-- exact same parameter names (just declared in a different order), so
-- Postgres cannot pick a candidate and raises:
--   42725: function public.submit_coaching_report(...) is not unique
-- on every single interactive submit attempt, regardless of role. The report
-- stays stuck at status = 'draft' and the coached employee is never notified.
--
-- This drops only the stale original-schema overload. The intended six-arg
-- (report_id, actor_hr_id, area_of_development, strength_points,
-- general_remarks, scores) signature from 20260619054913 is untouched.

begin;

drop function if exists public.submit_coaching_report(uuid, text, jsonb, text, text, text);

-- Guard: fail loudly if the fix didn't leave exactly the one intended overload.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_coaching_report';

  if v_count <> 1 then
    raise exception 'Expected exactly 1 submit_coaching_report overload after cleanup, found %', v_count;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
