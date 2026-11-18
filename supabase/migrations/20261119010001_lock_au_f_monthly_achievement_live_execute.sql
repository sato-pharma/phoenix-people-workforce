-- lock_au_f_monthly_achievement_live_execute
--
-- WHAT THIS CHANGES:
--   au.f_monthly_achievement_live(text) gets the same execute grant as its sibling
--   au.f_monthly_achievement(text): the owner (postgres) and service_role only. Before this it had a
--   NULL ACL, which in Postgres means EXECUTE for PUBLIC, so anon and authenticated could run it.
--   No function body changes and no data is read or written.
--
-- WHY:
--   It is a SECURITY DEFINER function owned by postgres that returns every rep's and every manager's
--   monthly sales and target figures. Today the only thing keeping a browser role out is that the
--   `au` schema grants USAGE to neither anon nor authenticated (20261008013000 left it alone for
--   exactly that reason). That is one grant away from an exposure: a single `grant usage on schema
--   au` would make it callable with the key that ships in the browser bundle. The 18 Nov 2026
--   Supabase audit asked for the function itself to be closed, matching the sibling.
--
--   Nothing that runs today loses access. Its one caller is au.f_monthly_achievement (SECURITY
--   DEFINER, owned by postgres), which is itself called only by public.phx_monthly_achievement and
--   au.f_sales_vs_target_range (both SECURITY DEFINER, owned by postgres, executable by postgres and
--   service_role only). Inside those, the call to f_monthly_achievement_live runs as postgres, the
--   owner, which keeps EXECUTE. No app code, cron job or view names it (checked on production and on
--   origin/main, 19 Nov 2026).
--
-- ROLLBACK:
--   grant execute on function au.f_monthly_achievement_live(text) to public;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it changes one function's ACL and is safe to replay.

begin;

revoke execute on function au.f_monthly_achievement_live(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement_live(text) to service_role;

-- Fail loudly if the result is not what this migration claims.
do $$
declare
  v_oid oid := 'au.f_monthly_achievement_live(text)'::regprocedure;
begin
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'au.f_monthly_achievement_live is still executable by a browser role';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE')
     or not has_function_privilege('postgres', v_oid, 'EXECUTE') then
    raise exception 'au.f_monthly_achievement_live lost execute for postgres or service_role';
  end if;
end
$$;

commit;
