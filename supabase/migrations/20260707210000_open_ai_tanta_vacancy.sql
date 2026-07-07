-- The Anti Infective "Tanta" area (ai_tanta) lost its only rep (B-179, moved to Mahalla
-- under DM B-12) without a replacement vacancy ever being opened. The organogram renders
-- exclusively from position_vacancies rows (src/lib/reports/vacancies.ts) -- an active area
-- with 0 employees and 0 vacancy rows is simply invisible, not shown as vacant. This was the
-- only area company-wide in that state (verified 2026-07-07). Mirrors the shape of the
-- sibling VAC-STRUCT-AI-* rows opened by 20260706110000_sales_vacancy_layer_reconciliation.sql.
--
-- Replay-safe / idempotent: in a clean migration replay the full-revert migration
-- (20260707170000, step 4c) DELETEs ai_tanta before this runs, so this migration re-creates
-- the area if absent BEFORE opening the vacancy. On production the area already exists and the
-- vacancy already exists, so both statements are no-ops (ON CONFLICT DO NOTHING + NOT EXISTS
-- guard). Without step 1, a fresh replay would find no ai_tanta row and silently create nothing.

-- 1) Ensure the Tanta area row exists (same pattern as restore_area_ids_after_unification_incident).
insert into areas (line_id, code, name, is_active) values
  (1, 'ai_tanta', 'Tanta', true)
on conflict do nothing;

-- 2) Open one vacant Medical Representative seat so Tanta renders as vacant in the organogram.
insert into position_vacancies (
  vacancy_code, department_id, line_id, area_id, team_id, position_id, job_title, status, manager_hr_id, note
)
select
  'VAC-STRUCT-AI-TANTA-MR', 1, 1, a.id, null, 2, 'Medical Representative', 'open', 'B-12',
  'Structure fix 2026-07-07: Tanta (ai_tanta) had 0 employees and 0 vacancy rows, making it invisible '
  || 'in the organogram after B-179 moved to Mahalla under DM B-12. Opened as a vacant seat under the '
  || 'same DM covering the adjacent Mahalla/KFS territory.'
from areas a
where a.code = 'ai_tanta' and a.line_id = 1
  and not exists (select 1 from position_vacancies v where v.vacancy_code = 'VAC-STRUCT-AI-TANTA-MR');
