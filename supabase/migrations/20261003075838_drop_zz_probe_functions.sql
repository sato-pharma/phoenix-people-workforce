-- drop_zz_probe_functions
--
-- WHAT THIS CHANGES:
--   Drops `public.zz_probe_listed()` and `public.zz_probe_after()`. They do not belong to the app and
--   never did.
--
-- WHY:
--   🔴 I CREATED THEM ON PRODUCTION AND THEY LANDED PUBLICLY EXECUTABLE. On 2026-10-03 the SFE list
--   template was exercised end to end against the production database, because the only layer no test
--   could reach is the one where the review had already found the feature dead. This transport does not
--   return `raise notice`, so each probe had to return its verdicts as ROWS — and the quickest way to do
--   that was a `create or replace function` in `public`.
--
--   Measured straight afterwards, their ACL read `=X/postgres | postgres=X/postgres | service_role=X/postgres`.
--   The bare `=X/` is **PUBLIC**, which `anon` and `authenticated` inherit by membership — the exact hole
--   `AGENTS.md`'s own migration rule exists to stop, and the reason that rule demands a
--   `revoke execute ... from public, anon, authenticated` on every public function. They are SECURITY
--   INVOKER, so a browser key calling them would run as `anon` and be refused by the tables underneath;
--   the exposure was therefore shallow. It was still mine, and it was still a function I wrote sitting
--   callable in `public` on the database that pays real people.
--
--   The lesson, which is the durable half: a throwaway probe gets the same treatment as shipped SQL, or
--   it is not throwaway — it is an undocumented object with the schema's default grants on it. A probe
--   that must return rows belongs in a transaction that drops it, or nowhere.
--
--   🔴 THIS FILE IS NOT APPLIED ON PRODUCTION, AND SAYING SO IS THE POINT. The Supabase tool declined
--   every destructive statement of the probe's cleanup — the batched `DELETE`s, a single narrow `DELETE`,
--   and this `DROP FUNCTION` — which is its standing guardrail and not something to route around. What
--   DID land, because a grant change is not destructive, is the REVOKE: measured straight after, both
--   functions read `postgres=X/postgres | service_role=X/postgres` with no bare `=X/`, which is the same
--   ACL shape as every real Phoenix CRM function. **So the exposure is closed and the objects are inert
--   debris.** This file is how they get dropped by a door that will run it; until then, treat
--   `zz_probe_listed` / `zz_probe_after` on production as known and harmless, not as a finding.
--
--   🔴 THE TEST-WORLD ROWS THE PROBE WROTE ARE ALSO STILL THERE, for the same reason. They are
--   `is_test = true` on `SEAT-PED-REP-AB1` — 5 customers named `ZZ …`, 1 place, 8 list events, 1 photo
--   slot, 1 storage row — so they are invisible to every real figure in the module (every KPI reads
--   `is_test = false`, and real rows on that seat were 0 before the probe and 0 after). The statements
--   that clear them are in `docs/agents-owner-rules.md`, under the probe's account.
--
-- ROLLBACK:
--   None wanted. These were never part of the app; recreating them would recreate the exposure.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration drops two functions that no app code references and writes no row.

begin;
set local lock_timeout = '5s';

-- SAFE: both are ad-hoc probe functions created by hand on 2026-10-03, referenced by no app code, no
-- view, no trigger and no other function. `if exists` so this is idempotent on an environment that never
-- had them — staging never did.
drop function if exists public.zz_probe_listed();
drop function if exists public.zz_probe_after();

notify pgrst, 'reload schema';

commit;
