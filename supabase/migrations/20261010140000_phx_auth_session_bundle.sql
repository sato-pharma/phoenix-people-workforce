-- 36% of every PostgREST round trip in Phoenix was answering "who is this user?".
--
-- Measured on production 2026-10-10 over a 118-minute window (pg_stat_statements):
--   set_config(search_path…)  176,110 calls  -- PostgREST's per-request preamble, so this IS
--                                            -- the count of HTTP round trips to the database
--   employees      (lifecycle)  21,366 calls  mean 0.06 ms
--   app_auth_users (account)    21,333 calls  mean 0.06 ms
--   app_sessions   (session)    21,333 calls  mean 0.08 ms
--
-- Those three identical counts are the auth trio that resolveSessionState() fires for every
-- authenticated request. They are 64,032 of the 176,110 round trips -- 36% of all PostgREST
-- traffic -- to do 0.2 ms of SQL. src/lib/auth/server.ts already wrapped them in Promise.all,
-- which made them concurrent (1 RTT of latency instead of 3) but left the COUNT at three
-- separate cross-border HTTPS calls, Railway (europe-west4) -> Supabase (eu-central-1).
--
-- This function returns all three rows in ONE call, so the trio costs 21,333 round trips per
-- two hours instead of 64,032 -- 42,699 fewer, a 24% cut in all PostgREST traffic.
--
-- IT RETURNS ROWS, NOT DECISIONS, ON PURPOSE. Every rejection check, audit write and error
-- path stays in TypeScript, in exactly the order resolveSessionState() already ran them
-- (app_sessions first, then app_auth_users, then the employees lifecycle gate). Moving policy
-- into SQL is what would make this risky; moving the three reads is what makes it fast.
--
-- maybeSingle() semantics are preserved exactly because all three keys are PRIMARY KEYS --
-- app_sessions(id), app_auth_users(login_id), employees(hr_id) -- so each lookup can only
-- return 0 or 1 rows and the "more than one row" error maybeSingle() raises is unreachable.
-- Verified on production 2026-10-10: 0 duplicate hr_ids in 213 employees, 0 duplicate
-- login_ids in 205 accounts.

-- An earlier revision of this function took a third argument, p_hr_id, and fell back to the
-- token's hr_id when the account row carried none. That fallback was wrong: it is NOT what
-- resolveSessionState() keys its gate on (see the key comment below), and measured against
-- 823 real production sessions it diverged on 203 of them -- 9 admin accounts whose
-- app_auth_users.hr_id is NULL. The decision came out the same either way, because a blank key
-- and a key matching no employees row both ALLOW, but it made the two keys disagree for a
-- quarter of all sessions and forced a pointless second gate evaluation. Dropped rather than
-- left in place: an argument that exists but must not be used is a trap for the next reader.
drop function if exists public.phx_auth_session_bundle(uuid, text, text);

create or replace function public.phx_auth_session_bundle(
  p_sid uuid,
  p_login_id text
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_session  jsonb;
  v_user     jsonb;
  v_employee jsonb;
  v_employee_lookup_failed boolean := false;
  v_employee_key text;
begin
  -- Column list is byte-identical to validateAppSession()'s select in
  -- src/lib/auth/app-sessions.ts -- that function reads these and makes every expiry,
  -- revocation and mismatch decision itself, so nothing here may drop a column.
  select to_jsonb(s) into v_session
    from (
      select id, login_id, hr_id, role, session_version, created_at, last_seen_at,
             idle_expires_at, absolute_expires_at, revoked_at, revoked_reason,
             supabase_session_required, supabase_session_available
        from public.app_sessions
       where id = p_sid
    ) s;

  -- Column list is byte-identical to resolveSessionState()'s app_auth_users select.
  -- is_test_persona / test_persona_of_hr_id carry his persona feature -- ten active accounts
  -- mirror real employees by design, so dropping them would break all ten.
  select to_jsonb(u) into v_user
    from (
      select login_id, hr_id, role, is_active, session_version,
             is_test_persona, test_persona_of_hr_id
        from public.app_auth_users
       where login_id = p_login_id
    ) u;

  -- THE GATE KEY IS THE FRESH ACCOUNT ROW'S hr_id, AND NOTHING ELSE -- the same expression
  -- resolveSessionState() uses for effectiveHrId on the ordinary path. The token's hr_id is
  -- deliberately not consulted: the old code could only GUESS with it, and then paid a FOURTH
  -- round trip to re-read keyed on the row whenever the guess was wrong. Reading the account
  -- row first in this same call makes the guess unnecessary and deletes that fourth call.
  --
  -- Two cases key on nothing, both correct:
  --   no account row at all -> the caller rejects with missing_user before it ever reads the
  --     gate, so the value here is immaterial;
  --   a test persona -> its own hr_id must be blank (a persona carrying one is rejected), and
  --     the effective id is the employee it MIRRORS, which only TypeScript can resolve. The
  --     caller sees the reported key differ and re-reads the gate on the mirrored person, so a
  --     persona still stops the day that person leaves.
  v_employee_key := nullif(btrim(coalesce(v_user->>'hr_id', '')), '');

  if v_employee_key is not null then
    begin
      select to_jsonb(e) into v_employee
        from (
          select employment_status, last_working_date
            from public.employees
           where hr_id = v_employee_key
        ) e;
    exception when others then
      -- resolveEmployeeLifecycleGate() fails CLOSED on an unexpected lookup error, and that
      -- is reported as a FLAG rather than raised, so a failure here still denies with
      -- employee_lookup_failed instead of throwing. Raising would turn one unreadable
      -- employees row into a thrown error for the whole bundle, which is the amplification
      -- that signed everyone out on 2026-10-10 (a fail-closed gate read as a resignation).
      v_employee_lookup_failed := true;
      v_employee := null;
    end;
  end if;

  -- A NULL member means "no such row", which the caller must distinguish from "not looked
  -- up": employee_key is null only when there was no hr_id to look up at all.
  return jsonb_build_object(
    'app_session', v_session,
    'auth_user', v_user,
    'employee', v_employee,
    'employee_lookup_failed', v_employee_lookup_failed,
    'employee_key', v_employee_key
  );
end;
$function$;

comment on function public.phx_auth_session_bundle(uuid, text) is
  'Resolves the auth trio (app_sessions, app_auth_users, employees lifecycle) in ONE round trip '
  'for src/lib/auth/server.ts. Returns rows, never decisions -- all policy stays in TypeScript. '
  'service_role only: the payload is session and account data for an arbitrary login_id.';

-- SECURITY BOUNDARY. This takes a login_id and returns that account's session and lifecycle
-- data with no authorization check of its own, because its only caller is the service-role
-- admin client inside resolveSessionState(). It must never be reachable from a browser key.
-- The function is deliberately NOT security definer -- it needs no elevation, since the
-- service role already bypasses RLS -- so these grants are the whole boundary.
revoke all on function public.phx_auth_session_bundle(uuid, text) from public;
revoke all on function public.phx_auth_session_bundle(uuid, text) from anon;
revoke all on function public.phx_auth_session_bundle(uuid, text) from authenticated;
grant execute on function public.phx_auth_session_bundle(uuid, text) to service_role;
