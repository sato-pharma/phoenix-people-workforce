-- add_outstation_pharmacy_workload
--
-- WHAT THIS CHANGES: adds one NULLABLE column, `pharmacy_workload`, to
--   public.outstation_expense_requests (integer, beside am_workload/pm_workload) and
--   public.outstation_expenses (numeric, beside its am_workload/pm_workload).
--   No default, no backfill, no constraint, no grant change — every existing row reads NULL.
--
-- WHY: THE AM · PM · PHARMACIES GOLDEN RULE (owner, 2026-09-21). A trip's field workload is three
--   figures reported apart; a pharmacy visit is never counted inside PM (the doctors) or AM. Until
--   now the capture filed a pharmacy visit into AM or PM by its vendor-tagged period, so the third
--   figure needs somewhere to live. Owner decision, same day: pharmacies are the third figure AND
--   field work, so a pharmacy-only trip is "matched", never "no activity".
--
--   NULL is deliberate and means "not counted separately": a trip stamped before this split (its
--   pharmacy visits still sit inside am_workload/pm_workload), a hand-typed workload, or an
--   Excel-imported expense. It is never 0 — a 0 would claim "no pharmacy visits" about a trip whose
--   pharmacy visits are already inside AM/PM. Old trips are NOT backfilled (owner rule: a recorded
--   workload stays as recorded).
--
--   Money: no pay formula reads am_workload/pm_workload. The workload gate clears on capture, and
--   the campaign cap reads double-visit counts from the evidence snapshot, not these columns.
--
-- ROLLBACK:
--   alter table public.outstation_expense_requests drop column if exists pharmacy_workload;
--   alter table public.outstation_expenses drop column if exists pharmacy_workload;
--   (Only the pharmacy figures captured after this migration are lost; AM/PM are untouched.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists pharmacy_workload integer;

comment on column public.outstation_expense_requests.pharmacy_workload is
  'Trip pharmacy visits — the third workload figure (AM · PM · Pharmacies), never inside am_workload or pm_workload. NULL = not counted separately (stamped before 2026-09-21, typed by hand, or imported).';

alter table public.outstation_expenses
  add column if not exists pharmacy_workload numeric;

comment on column public.outstation_expenses.pharmacy_workload is
  'Trip pharmacy visits — the third workload figure (AM · PM · Pharmacies), never inside am_workload or pm_workload. NULL = not counted separately (stamped before 2026-09-21, typed by hand, or imported).';

commit;

-- Timestamp 20260921082722 was minted to sort after every migration already on main.
