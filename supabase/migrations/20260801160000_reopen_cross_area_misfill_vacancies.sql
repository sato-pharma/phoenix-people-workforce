-- Data remediation: reopen the 5 replacement vacancies that the pre-fix, area-blind
-- phx_reconcile_stale_replacement_vacancies() wrongly closed (see migration
-- 20260801150000_fix_reconcile_stale_vacancy_area_and_single_seat.sql). Each was marked
-- 'filled' by a same manager+line+title employee who actually works in a DIFFERENT area, so
-- the seat reads filled when it is really vacant, hiding a genuine open seat from the vacancy
-- report and the hire/edit "Operating Area" dropdowns.
--
--   vacancy 173 (resignation_B-150)   filled_by B-189   -> departed B-150 (Sohag/Qena area)
--   vacancy 299 (VAC-TERM-B150-001201) filled_by B-189   -> departed B-150
--   vacancy 248 (VAC-B174-521)         filled_by AI-0003 -> departed B-174 (Heliopolis area)
--   vacancy 297 (VAC-TERM-B174-9e2213) filled_by AI-0003 -> departed B-174
--   vacancy 263 (VAC-B97-I6S)          filled_by AI-0006 -> departed B-97  (Mahalla area)
--
-- Scope: public.position_vacancies ONLY. The `au` seat model (the organogram's source of
-- truth) was never corrupted for these people — verified live: AI-0003 and B-189 already
-- occupy their correct au seats (CA3, UE8), AI-0006 holds no wrong-area seat, and the departed
-- are absent from au entirely. Reopening (filled -> open) fires no trigger
-- (trg_position_vacancies_hire_into_seat only fires on becoming filled), so the organogram is
-- untouched. Going forward the now-fixed reconciliation only refills a seat with a SAME-area
-- replacement, and its single-seat guard prevents refilling both of a duplicated pair.
--
-- Guarded + idempotent: only a row still in its exact phantom-filled state (matching id +
-- wrong filler) is touched, so this is a safe no-op on staging / any environment where the
-- state differs, and on re-run (after reopening, filled_by is null so nothing re-matches).
-- A point-in-time snapshot of the affected rows is captured OUTSIDE this file at apply time; a
-- snapshot table in `public` is intentionally NOT created here (check:sql-backups forbids it).

update public.position_vacancies as v
set
  status = 'open',
  filled_by_hr_id = null,
  filled_at = null,
  replacement_for_hr_id = m.departed_hr_id,
  note = concat_ws(
    E'\n',
    nullif(v.note, ''),
    'Reopened ' || current_date::text
      || ': reverting a cross-area mis-close by the pre-fix replacement reconciliation'
      || ' (see migration 20260801150000). Seat is genuinely vacant.'
  ),
  updated_at = now()
from (values
  (173, 'B-189',   'B-150'),
  (299, 'B-189',   'B-150'),
  (248, 'AI-0003', 'B-174'),
  (297, 'AI-0003', 'B-174'),
  (263, 'AI-0006', 'B-97')
) as m(vacancy_id, wrong_filler_hr_id, departed_hr_id)
where v.id = m.vacancy_id
  and lower(coalesce(v.status, 'open')) = 'filled'
  and v.filled_by_hr_id = m.wrong_filler_hr_id;
