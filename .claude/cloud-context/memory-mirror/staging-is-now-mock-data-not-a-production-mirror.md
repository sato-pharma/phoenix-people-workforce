---
name: staging-is-now-mock-data-not-a-production-mirror
description: "Staging (cifwmndunmlxjhyjugxa) is a FULL PHYSICAL CLONE of production taken 2026-08-29 - REAL production data: 161 real auth accounts WITH password hashes, real payroll, real names. NOT demo-safe, must NEVER be handed to a videographer/third party, and logging in needs PRODUCTION credentials. The 2026-08 anonymised mock is GONE (reversed then re-cloned). Storage FILES do not clone - 910 objects list but every CV/photo 404s. A branch CAN be previewed on staging with `railway up` (environment-scoped, production untouched) - NOT `railway service source connect`, which is service-level and repoints production. A blank manager keycard in staging is almost always the monthly_closing_publications gate, not broken data."
metadata:
  node_type: memory
  type: project
  originSessionId: 52493c41-8681-4061-aa67-4d730444cc29
  modified: 2026-09-25T23:17:24.180Z
---

**Staging `cifwmndunmlxjhyjugxa` is a full physical clone of production, taken 2026-08-29 ~08:00 UTC —
REAL production data, not a demo.** It holds production's **161 real `auth.users` rows including
password hashes**, all 179 employees, 796 salary records, 11,267 sales records and real
doctor/pharmacy/employee names. (`auth` had to be cloned: staging's own 25 accounts had zero id
overlap with production, so without it every `employees` row would point at a missing user.)

Consequences that bite:

- 🔴 **Staging must NEVER be handed to a videographer or any third party in this state**, and logging
  in there now needs **production credentials** — this is the exact opposite of the (now-dead) mock
  posture below.
- **Treat staging figures as real** — they equal production at the clone instant. Continuously-written
  tables (`ireports360_*`, `audit_logs`, `activity_events`, sessions) drift forward from the dump
  moment; that is drift, not corruption.
- 🔴 **A clone overwrites `ireports360_sync_notify` with production's `true` — re-apply `false` after
  any re-clone** or a staging sync test Telegrams every Super Admin. See
  [[ireports360-sync-notify-disabled-on-staging]].
- **A clone CANNOT carry storage FILES.** The `storage.objects` metadata rows clone perfectly, so
  staging lists all **910 objects (~285 MB: 736 CVs, 86 outstation, 68 marketing, 9 photos)** and
  serves **none** — every CV download and photo **404s**. Copying the bytes is a separate job through
  the storage API.

## A branch CAN be previewed on staging — `railway up`, never `source connect` (2026-09-18, PR #4008)

AGENTS.md §2.3 says a branch "cannot be staged on Railway without shipping it." That is true of
`railway service source connect` (service-level — it repointed PRODUCTION) but **FALSE of `railway
up`**, which deploys ONE environment's instance and leaves production untouched. Proven live when the
owner asked to press a CV himself before merging. The recipe:

- Build the would-be merge touching no checkout: `git merge-tree --write-tree origin/main <branch>`,
  then `git archive <tree> | tar -x -C <scratch>`. Base on the **newest** main (staging runs main, so
  an older base rolls other sessions' merges back there); confirm it differs from main in exactly the
  PR's files.
- Run from that UNLINKED scratch folder with every target as an ID, so a dropped flag errors instead
  of falling through to the primary's production link:
  `railway up . --path-as-root -p <project> -e <staging-env> -s <service> --detach -m "PREVIEW ONLY"`.
  **Never `-y`** — with nothing linked it implies `--new`, a new project.
- 🔴 **`.railwayignore` reads like `.gitignore`, NOT `.dockerignore`:** a bare `supabase` also dropped
  `src/lib/supabase` and the build died on 459× `Can't resolve '@/lib/supabase/server'`. **Anchor
  every folder with `/`** (`/supabase`, `/tests`, `/docs`).
- **"Preview is up" signal:** while the upload serves, STAGING's `/api/healthz` reads
  `"revision": null` (no `RAILWAY_GIT_COMMIT_SHA`); production's healthz keeps the main SHA and its
  deployment list shows no upload. The next main push auto-deploys staging and **ends** the preview.
- The auto-mode classifier blocks the upload (and even `railway deployment list`) as "Modify Shared
  Resources" until the owner asks for it in chat.

## A blank manager keycard in staging is the publish gate, not broken data

Every manager keycard reads only periods whose **line-scoped Monthly Closing is PUBLISHED** —
`loadPublishedPeriodKeys` (`src/lib/sales/vs-target.ts`) keys on `resolveTargetLineCode(line)+period`
and drops everything else, so with no published row in the window every manager dashboard reads team 0
/ sales 0 / target 0 / "No sales data synced," **even when the rollup and org seats are perfect.** Fix
by inserting the period's rows into `monthly_closing_publications` directly (bypasses `publishClosing`,
so no notification/email fires). `loadPublishedPeriodKeys` is not cached, so it shows on the next
reload. (August stays deliberately unpublished — `closing-period-gate.ts` forbids releasing a month
during that month.)

## The 2026-08 mock is GONE — `mock_backup` schema is the kept safety net

Staging was anonymised 2026-08-28 for a screen-recording, then the owner ordered it reversed
("remove the mock data … sync staging with main") and finally re-cloned from production. **So no mock
content is live any more.** The `mock_backup` schema is **kept** as the safety net — notably
`name_map_final` (the 666 real→fake pairs, the only surviving record of the mapping) and `inverse_map`.
Do not attempt an inverse scrub: only 367 of 666 reverse unambiguously, so it would leave a half-real
state that reads as authoritative. Full mock forensics and the name-collision traps live in
[[a-mock-name-generator-reproduces-real-employee-names]].

## If you ever re-clone production → staging, four traps that cost real debugging

Scripts lived in the session scratchpad, not the repo; native `pg_dump` reproducing Supabase's flag
set (because `supabase db dump` needs Docker):

- **Supabase's dump splits `auth`/`storage` asymmetrically** — the SCHEMA dump excludes them
  (platform-managed) while the DATA dump includes them. Copying the schema exclusion list into the
  data step silently ships an **empty `auth`**.
- **`drop schema public cascade` exhausts `max_locks_per_transaction` (64) at ~368 tables**
  (`out of shared memory`). Batch `COMMIT`s inside DO blocks, so the restore must NOT run under
  `--single-transaction`.
- **The migration ledger is excluded from BOTH dumps** — dump/load `supabase_migrations.schema_migrations`
  (775 rows) separately, or the next `db push` replays every migration.
- **`storage.buckets_vectors` / `storage.vector_indexes` cannot be truncated by this role** — both are
  empty on production, so guard the truncate with `has_table_privilege(..., 'TRUNCATE')`.

Related: [[never-change-the-organogram-skeleton]] · [[a-mock-name-generator-reproduces-real-employee-names]]
