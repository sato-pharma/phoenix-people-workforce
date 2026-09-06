-- `sos_import_coverage_snapshots` has two writers, and they filled the same columns with different
-- meanings. The brick-coverage writer measures rows and units but never money and never new
-- customers, and it stored `unitsWithBrick` in `importable_value` (a unit COUNT in a money column)
-- and `customersNeedingBrick - customersWithBrick` in `new_customers` (the BRICK-LESS count, a
-- different question). Measured on production before this change: 91 of 134 snapshots held a
-- "value" that is at most 5% of their own batch's actual value, and every one of them tracked that
-- batch's UNIT count instead.
--
-- Both now write NULL, which is the truthful "this writer did not measure it" — but the columns were
-- NOT NULL DEFAULT 0, so those inserts fail with 23502. `saveBrickCoverageSnapshot` logs rather than
-- throws, so the failure is SILENT: coverage snapshots would simply stop being recorded for that
-- pipeline, with the Coverage tab quietly going stale rather than erroring.
--
-- Making the columns nullable is additive: every existing row keeps its value, and readers already
-- distinguish null ("not measured") from 0 ("measured, and it was none").
alter table public.sos_import_coverage_snapshots
  alter column importable_value drop not null,
  alter column new_customers drop not null;

-- The DEFAULT 0 has to go too. Left in place it silently turns an omitted column back into a zero
-- for any future writer that simply does not mention it — re-creating the exact lie this removes,
-- and doing it invisibly. "Absent" must stay absent.
alter table public.sos_import_coverage_snapshots
  alter column importable_value drop default,
  alter column new_customers drop default;
