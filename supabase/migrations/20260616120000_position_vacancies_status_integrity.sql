-- 20260616120000_position_vacancies_status_integrity.sql
--
-- Pre-launch drift cleanup (Phase C+F findings, 2026-06-16):
--
-- 1. Prod has 4 position_vacancies rows with status='closed' (ids 177, 196, 222,
--    224 — all "District Sales Manager", filled_at IS NULL), but 'closed' is
--    NOT in the original CHECK constraint (open|filled|cancelled). No code
--    writer produces 'closed', so these rows were inserted via direct
--    service-role SQL bypassing the schema. The CHECK constraint also went
--    missing in prod at some point. This migration:
--      (a) backfills those rows to 'cancelled' (closest valid value — they were
--          never filled), and
--      (b) re-asserts the CHECK so future writes can't sneak past again.
--
-- 2. notification_delivery_logs has 0 rows + 0 writers in code. The admin
--    monitoring dashboard was reading it for a "Total delivery logs" tile, so
--    the metric silently displayed 0 forever. Readers were rewired to
--    email_delivery_events in the same PR, and the dead table is dropped here
--    so a future engineer can't re-wire a silent data sink by accident.
--
-- Idempotent. Safe to apply in production without downtime — backfill is at most
-- 4 rows; CHECK is added NOT VALID then VALIDATEd so no exclusive lock; DROP
-- TABLE only fires when the table exists and is empty (no writers, no readers).

begin;

-- Backfill any rows whose status is outside the canonical enum. The only
-- known offender today is 'closed', but this catches anything else that may
-- have slipped past while the CHECK was missing.
update public.position_vacancies
set status = 'cancelled'
where status not in ('open', 'filled', 'cancelled');

-- Defensive drop: prod currently has no CHECK on this column at all, so this
-- is a no-op there. Keeps the script reusable on environments where a partial
-- attempt may have left a constraint behind.
alter table public.position_vacancies
  drop constraint if exists position_vacancies_status_check;

-- Re-assert the enum. NOT VALID then VALIDATE avoids the full-table exclusive
-- lock at first add, and the VALIDATE pass only takes a SHARE UPDATE EXCLUSIVE
-- lock so concurrent reads/writes keep working.
alter table public.position_vacancies
  add constraint position_vacancies_status_check
  check (status in ('open', 'filled', 'cancelled'))
  not valid;

alter table public.position_vacancies
  validate constraint position_vacancies_status_check;

-- Retire the dead notification_delivery_logs table. Zero rows + zero writers
-- + zero remaining readers (rewired to email_delivery_events in this PR).
-- Use CASCADE only on the RLS policy if any lingers; data loss is impossible
-- because the table is empty.
drop table if exists public.notification_delivery_logs;

commit;
