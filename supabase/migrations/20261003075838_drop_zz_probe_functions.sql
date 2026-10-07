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
--   🔴 APPLIED ON PRODUCTION 2026-10-07, FOUR DAYS AFTER THIS FILE WAS WRITTEN. The header this
--   replaces said "THIS FILE IS NOT APPLIED ON PRODUCTION, AND SAYING SO IS THE POINT", and it was
--   right to say so — but for those four days the two functions sat on production as the ONLY two
--   `function_search_path_mutable` findings on the security advisor, so the next session to read that
--   WARN found them cold and had to re-derive this whole account before it could act.
--
--   What landed on 2026-10-03, because a grant change is not destructive, was the REVOKE: both
--   functions read `postgres=X/postgres | service_role=X/postgres` with no bare `=X/`, the same ACL
--   shape as every real Phoenix CRM function — so the exposure was closed from that day and what
--   remained was inert debris. The `DROP FUNCTION` was declined on 2026-10-03 and declined AGAIN on
--   2026-10-07 by `supabase-production`; it ran through the account connector the owner allowed on
--   2026-10-05. One apply, one ledger row, `statements` populated — so the declined call did not also
--   land (`a-declined-tool-call-is-not-proof-the-change-did-not-land`).
--
--   Ledger version `20261007203921`, not this filename: `apply_migration` stamps its own UTC version,
--   so this file's version being absent from `supabase_migrations.schema_migrations` is the EXPECTED
--   state, never drift (`a-ledger-version-never-matches-the-file`). Verified against `pg_proc`, not the
--   ledger: 0 functions matching `zz_probe%` in `public`, `phoenix_crm_validate_customer` untouched and
--   still present, and `function_search_path_mutable` gone ENTIRELY from the advisor — the lint no
--   longer appears at all, rather than merely dropping from 2 findings to fewer.
--
--   This migration dropped only the two functions and neither read nor wrote any
--   `phoenix_crm_customers` row. The test-world rows the probe wrote — `is_test = true` on
--   `SEAT-PED-REP-AB1`: 5 customers named `ZZ …`, 1 place, 8 list events, 1 photo-upload row and 1
--   `storage.objects` row — were cleared separately on 2026-10-08 on the owner's word, with a
--   pre-image in `crm_backup_20261008`. The probe now has NOTHING left on production. The account,
--   including why the documented `delete from storage.objects` could never run, is in
--   `docs/agents-owner-rules.md` under the probe's section.
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
