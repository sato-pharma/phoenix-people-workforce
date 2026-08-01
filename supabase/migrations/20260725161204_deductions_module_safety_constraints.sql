-- Unified Deductions module — PR-1 safety backstops.
--
-- These constraints exist so the two most dangerous failure modes stay
-- impossible even if a future code path forgets the application-level guard.
-- Application code is the first line of defence; this is the second.

-- ---------------------------------------------------------------------------
-- 1. A day-based publication line may never carry a zero amount.
--
-- "We could not compute this employee's amount" previously collapsed to
-- applied_amount = 0.00 via a `?? 0` fallback in publish.ts, which is
-- indistinguishable from a successful publish while actually deducting
-- nothing. publishMonth now refuses such a candidate outright; this CHECK
-- guarantees the invariant at the storage layer too.
--
-- unit = 'amount' rows are exempt: a manually-entered monetary deduction is
-- already an explicit figure, and a 0 there would be a no-op the HR user
-- deliberately typed.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'deductions_publication_lines_day_amount_positive'
      and conrelid = 'public.deductions_publication_lines'::regclass
  ) then
    alter table public.deductions_publication_lines
      add constraint deductions_publication_lines_day_amount_positive
      check (unit <> 'days' or applied_amount > 0);
  end if;
end $$;

comment on constraint deductions_publication_lines_day_amount_positive
  on public.deductions_publication_lines is
  'A day-based deduction can never publish at 0.00 — that is "amount unknown" masquerading as "deduct nothing". Enforced in publish.ts first; this is the storage-layer backstop.';

-- ---------------------------------------------------------------------------
-- 2. One employee-day may only be PAID once, across all categories.
--
-- Fingerprint, CRM and No-Records-Activity can each independently flag the
-- same absence day. They are different categories with different candidate_keys,
-- so the existing (category, candidate_key) unique index does not stop them —
-- the employee was simply deducted three times for one day.
--
-- Deliberately enforced at PUBLICATION, not at candidate insert:
--   * Two candidates for one day is a legitimate intermediate state — three
--     detectors noticing the same absence is exactly what they are meant to do,
--     and HR needs to SEE both to decide which is right. Blocking the insert
--     would abort an entire collection run over a data condition that is
--     expected and reviewable.
--   * Publishing two of them is never legitimate — that is the moment real
--     money is committed.
-- src/lib/deductions/conflict.ts flags the overlap during collection (surfaced,
-- not fatal) and publishMonth refuses to publish one; this trigger is the
-- backstop for both.
--
-- A trigger rather than a unique index because Postgres cannot build a plain
-- unique index over an unnested jsonb array — and a trigger can name the exact
-- day and employee that collided, which an index violation cannot.
-- ---------------------------------------------------------------------------

create or replace function public.deductions_publication_lines_guard_day_overlap()
returns trigger
language plpgsql
as $$
declare
  v_conflict record;
begin
  select l.category, d.day, l.candidate_id
    into v_conflict
  from public.deductions_publication_lines l
  cross join lateral jsonb_array_elements_text(l.dates) as d(day)
  join public.deductions_publications p on p.id = l.publication_id
  where l.publication_id = new.publication_id
    and l.employee_hr_id_compact = new.employee_hr_id_compact
    and l.id <> new.id
    and p.status = 'published'
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

drop trigger if exists deductions_publication_lines_guard_day_overlap_trg
  on public.deductions_publication_lines;
create trigger deductions_publication_lines_guard_day_overlap_trg
  before insert on public.deductions_publication_lines
  for each row execute function public.deductions_publication_lines_guard_day_overlap();

comment on function public.deductions_publication_lines_guard_day_overlap() is
  'Structural double-deduction guard: within one publication, an employee-day may be paid at most once across ALL categories. Fingerprint/CRM/No-Records-Activity can each flag the same absence day independently; without this the employee is deducted once per pipeline.';
