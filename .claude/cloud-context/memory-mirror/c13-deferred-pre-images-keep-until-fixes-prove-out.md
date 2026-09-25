---
name: c13-deferred-pre-images-keep-until-fixes-prove-out
description: "The 5 unexposed 08-28/08-29 HR+CRM rollback pre-image tables are a DELIBERATE keep (deferred from Track C) — do not DROP until the 08-29 hire-date/probation fixes prove out through September payroll. Already moved out of `public` into `hr_backup_20260829`/`crm_backup_20260828` by migration 20260830133000 (CI-drift-check hygiene, not the C13 trigger) — same day, fully reversible, all 5 row counts unchanged. Re-verified live 2026-09-03: September payroll run still does not exist (only July published, August at part2) — the actual drop trigger has not fired."
metadata: 
  node_type: memory
  type: project
  originSessionId: e97e73e0-80f2-462a-8d5c-7c9b21f03938
  modified: 2026-09-03T00:58:14.107Z
---

## Re-verified 2026-09-03 against production

**All 5 tables still exist, all 5 row counts unchanged** (2 / 1 / 6 / 1 / 0 — matches both the
08-30 memory and the moving migration's own pre-move count) — but they are **no longer in
`public`**. Migration `20260830133000_move_adhoc_pre_images_out_of_public.sql`, applied the same
day this memory was written (08-30, ~9.5h later), relocated all 5 via `ALTER TABLE ... SET SCHEMA`
into `hr_backup_20260829` (the 3 HR pre-images) and `crm_backup_20260828` (the 2 CRM ones — schema
names match the fix vintage, not the move date). **This was not the C13 retirement the trigger below
gates** — the migration's own header explains a separate, more urgent driver: the `Migration Drift
Check` CI workflow had been RED daily since 2026-08-24 because these primary-key-less,
`create table as select` snapshots trip its `missing_primary_key` check regardless of exposure, and
that check Telegrams the owner on every red run. `SET SCHEMA` is fully reversible in one statement
per table (`alter table <schema>.<name> set schema public`), preserves every row/column/grant, and
each destination schema's `comment on schema` now states in the database itself: kept until
September payroll and probation prove the 08-29 fixes out, then dropped — i.e. it encodes exactly
the retire trigger below, it just isn't the retire itself.

**The actual drop trigger still has not fired.** No `automated_payroll_runs` row for September exists
yet — only July (`published`) and August (`part2`, part1 confirmed 2026-08-30, part2 not yet
confirmed). Nothing to do here until a September run exists and closes clean.

---

Owner decision 2026-08-30: **leave these 5 pre-image tables in `public`, revisit as "C13" later.** They are the fresh rollback nets for the 08-28/08-29 production surgery and were deliberately deferred out of Track C's C11 ([[hire-date-change-doubles-probation-reminders]] is the class of change they protect):

- `hire_date_fix_20260829_pre` (2 rows) — pre-image of the 08-29 hire-date correction
- `probation_fix_20260829_pre` (1 row)
- `probation_reanchor_20260829_pre` (6 rows)
- `zz_backup_crm_customer_brick_resolutions_20260828` (1 row)
- `zz_backup_crm_region_brick_resolutions_20260828` (0 rows)

Verified live 2026-08-30: all owned by `postgres`, RLS off, **NOT exposed** — `has_table_privilege` is false for anon AND authenticated (SELECT and INSERT), no PUBLIC grant; 0 FKs, 0 triggers, 0 dependent views; **zero code references** (captured ad-hoc during surgery, so they exist only in the DB, not as committed migration files).

**Why NOT retire now (unlike C7–C12):** every Track C retirement removed something from the PostgREST-exposed surface — these are already off it (no grants), so archiving them buys nothing but cosmetic tidiness. Meanwhile they back up hire dates and probation anchors that feed **September payroll and the probation-reminder automation**, neither of which has run yet against the corrected values. The 08-19 set C11 retired had 11 days of proven stability; these have ~1.

**Retire trigger (do it as C13):** after September payroll + probation processing runs clean against the 08-29 fixes, and the CRM brick resolutions hold through a closing/sync cycle. Then move them into a dated archive schema via `ALTER … SET SCHEMA`, same reversible pattern as [[a-cv-import-overwrote-a-candidates-whole-identity]]'s siblings — i.e. C10/C11/C12 (`messaging_backup_20260830`, `zz_rollback_archive_20260830`, `workflow_backup_20260830`). Separate and already handled: the Delta (3) pre-image lives in schema `delta3_defer_backup_20260829.line_area_map_pre`, explicitly "keep" per AGENTS §4 — not one of these five, and already off `public`.
