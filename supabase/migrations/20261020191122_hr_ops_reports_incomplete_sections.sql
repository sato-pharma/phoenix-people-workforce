-- hr_ops_reports.incomplete_sections
--
-- WHAT THIS CHANGES: one new column on public.hr_ops_reports — `incomplete_sections`, the sections
--   whose last build could not read a source behind their ROWS in full (`["field"]`, `["office"]`,
--   both, or the empty default). Written by src/lib/hr-ops-reports/build.ts on every build and
--   rebuild, so a clean rebuild clears it. Nothing is backfilled: every report built before this
--   migration keeps the empty default, which reads as "complete", exactly as it does today.
-- WHY: a section whose source fails does not throw — buildFieldSection and buildOfficeSection
--   return `lines: []` with the reason named — so a degraded build wrote a report with rows
--   missing, `build_warnings` was the only trace, and nothing in the module gated on it. Two
--   things then went wrong silently:
--     * the stale sweep deleted the flagged rows nobody had answered yet (fixed in code, #6211);
--     * a degraded FIRST build has no rows to sweep at all, so `submitReport` found nothing
--       waiting, auto-decided the report on the spot, and `buildHrOpsReport` returned
--       `skipped: "frozen"` for ever after — those days never reached the weekly attendance review
--       and no screen said so.
--   Storing the fact on the report is what lets `submitReport` refuse to freeze a degraded build,
--   and it is a pure predicate over one row, so the rule is pinnable by the test suite.
-- ROLLBACK: alter table public.hr_ops_reports drop column if exists incomplete_sections; — only
--   src/lib/hr-ops-reports/ reads it, and the submit gate reads an absent column as complete.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one additive column with a default, no row rewritten, no data removed.

begin;

alter table public.hr_ops_reports
  add column if not exists incomplete_sections jsonb not null default '[]'::jsonb;

comment on column public.hr_ops_reports.incomplete_sections is
  'The sections whose last build could not read a source behind their rows in full ("office" / "field"). Empty means the build was complete. A report with any entry cannot be submitted — it waits for a clean rebuild — and those sections are never swept of rows the build did not produce.';

commit;
