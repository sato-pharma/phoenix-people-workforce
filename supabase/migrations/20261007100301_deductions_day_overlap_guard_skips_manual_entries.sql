-- deductions_day_overlap_guard_skips_manual_entries
--
-- WHAT THIS CHANGES: public.deductions_publication_lines_guard_day_overlap() now
--   ignores lines whose candidate is a manual HR entry (deductions_candidates.
--   source_system = 'manual_hr'). Such a line neither BLOCKS another line nor IS
--   BLOCKED by one. Every other line is guarded exactly as before: two ACTIVE
--   lines of the same published publication may not deduct the same employee-day.
--
-- WHY: a manual entry has no real day. HR types an amount and a reason, and the
--   candidate is stamped with the deterministic placeholder `${monthKey}-01`
--   (src/lib/deductions/connectors/manual.ts). The application's own collision
--   check, findDayCollisions in src/lib/deductions/conflict.ts, already skips
--   source_system 'manual_hr' for that reason — but this trigger did not, so the
--   SECOND manual entry pushed for an employee in a month was refused with
--   "employee … is already being deducted for <month>-01". Measured 2026-10-07 on
--   production: Ahmed Nabil (September) holds 7 approved manual entries, all
--   dated 2026-09-01, and only the first could ever be pushed. No publication on
--   production has ever held two active manual lines on one day, so nothing
--   already paid was double-counted by the old rule — it only refused pushes.
--
-- ROLLBACK: re-run section 1b of
--   20260922021403_deductions_module_per_line_push.sql (the previous definition,
--   identical except for the two manual_hr clauses below). No data changes.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- CREATE OR REPLACE clears a function's proconfig, so the search_path pin from
-- 20260801140000 is restated here (as 20260922021403 did).
create or replace function public.deductions_publication_lines_guard_day_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conflict record;
begin
  -- A withdrawn line no longer deducts anything, so it must not block a re-push
  -- of the same candidate/day or a genuine push of a different candidate.
  if new.line_status <> 'active' then
    return new;
  end if;

  -- A manual HR entry's date is a `${monthKey}-01` placeholder, not a day the
  -- employee was absent — it claims no day, so there is nothing to collide on.
  if exists (
    select 1 from public.deductions_candidates c
    where c.id = new.candidate_id and c.source_system = 'manual_hr'
  ) then
    return new;
  end if;

  select l.category, d.day, l.candidate_id
    into v_conflict
  from public.deductions_publication_lines l
  cross join lateral jsonb_array_elements_text(l.dates) as d(day)
  join public.deductions_publications p on p.id = l.publication_id
  left join public.deductions_candidates c on c.id = l.candidate_id
  where l.publication_id = new.publication_id
    and l.employee_hr_id_compact = new.employee_hr_id_compact
    and l.id <> new.id
    and l.line_status = 'active'
    and p.status = 'published'
    -- …and a manual line's placeholder never blocks a real day either.
    and coalesce(c.source_system, '') <> 'manual_hr'
    and d.day in (select jsonb_array_elements_text(new.dates))
  limit 1;

  if v_conflict.day is not null then
    raise exception
      'deductions_publication_lines: employee % is already being deducted for % under category "%" in this publication — one employee-day may only be deducted once (conflicting candidate %)',
      new.employee_hr_id_compact, v_conflict.day, v_conflict.category, v_conflict.candidate_id
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

comment on function public.deductions_publication_lines_guard_day_overlap() is
  'Structural double-deduction guard: within one publication, an employee-day may be paid at most once across ALL categories. Fingerprint/CRM/No-Records-Activity can each flag the same absence day independently; without this the employee is deducted once per pipeline. Manual HR entries (source_system manual_hr) are exempt both ways — their date is a month placeholder, not a day (mirrors findDayCollisions).';

commit;
