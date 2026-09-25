---
name: resignation-transactional-rpc-authored
description: "public.phx_resign_employee_and_open_vacancy was missing on both staging and production despite the app always calling it — authored, tested, and now LIVE in production (PR 1165, 2026-07-19); before it every resignation ran a non-transactional 4-write JS fallback that never vacated the au seat."
metadata: 
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

**What was found:** `src/lib/resignations/service.ts` has always called `supabase.rpc("phx_resign_employee_and_open_vacancy", ...)` as its primary resignation path, but the function never existed in any migration on staging or production (confirmed via direct `pg_proc` queries on both). Every real resignation silently ran through a non-transactional 4-write JS fallback (`resignEmployeeWithFallback`) instead — no rollback if one write failed partway, and the fallback never touched `au` seat continuity at all.

**What was built:** authored the RPC in `supabase/migrations/20260718210000_phx_resign_employee_and_open_vacancy_rpc.sql` — opens the replacement vacancy, records the resignation, updates the employee's lifecycle fields, deactivates `app_auth_users`/`user_access_profiles`, and (new) vacates the employee's `au` seat via `au.resign_occupant` — all in one plpgsql transaction. Includes the explicit `revoke ... from authenticated` needed to close the [[public-schema-default-acl-grants-authenticated]] gap, caught while building this.

**Verification:** round-trip tested for real on staging (created a test employee, hired into a real vacant seat, called the RPC, verified all 4 target tables + the pre-existing terminal-vacancy trigger fired correctly, then fully cleaned up — zero residue, seat restored to its exact original occupancy row). Full `pnpm run check:harden` (lint/typecheck/408 tests/build) passed clean.

**Status: FULLY LIVE on production** as of 2026-07-19. Migration `20260718212030_phx_resign_employee_and_open_vacancy_rpc` applied (verified via `pg_proc.proacl` = `{postgres=X/postgres,service_role=X/postgres}` only). Code side merged via PR [#1165](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1165) (merge commit `b4104fb7`) and deployed — confirmed `b4104fb7` is an ancestor of the revision at 100% traffic (`phoenix-hr-00133-loj` / `sha-0a2e9dc3`) via `git merge-base --is-ancestor`, plus `/api/healthz` 200. The Telegram-deactivation-on-resignation fix, the photo-scope fix, and the redesigned xlsx template are all live — no outstanding gap.

**Lesson for next time:** in a fast-moving repo with multiple parallel sessions merging concurrently, `gcloud run services describe` showing a 100%-traffic revision tag that doesn't match your own merge SHA does NOT mean your change didn't ship — check ancestry (`git merge-base --is-ancestor <your-sha> <deployed-sha>`) before assuming something went wrong. Here `0a2e9dc3` (PR #1171, unrelated mobile fixes) simply merged and deployed shortly after `b4104fb7`.
