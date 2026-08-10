-- Index hygiene, from the 2026-08-10 production Postgres health audit.
--
-- 1. Drops two covering indexes on source_of_sales_import_rows that had NEVER been
--    scanned since the database was created (idx_scan = 0, last_idx_scan = NULL) while
--    all 13 sibling indexes on the same table were used within the preceding 24 hours.
--    They total 176 MB on a 129 MB heap. They date from the pre-baseline marketing-ROI
--    dashboard, which was later "refocused" — the query shape they were built for no
--    longer exists, which is why the planner never chose them.
--    Rollback DDL is preserved in db-snapshots-20260811/dropped-indexes-rollback.sql.
--
-- 2. Adds the 18 missing foreign-key covering indexes. Without one, deleting or updating
--    a parent row forces a sequential scan of the child table to enforce the constraint.
--    Every affected table is small today (0-154 rows) — which is exactly why this is
--    cheap to fix now rather than after the Early Birds and Deductions modules fill.
--
-- Deliberately NOT dropped: 329 further indexes report zero scans, but 328 of them sit
-- on tables holding under 1,000 rows, where the planner correctly prefers a sequential
-- scan regardless. They are not mistakes, they are indexes waiting for their table to
-- grow, and they cost 4.7 MB in total. Removing them would be churn, not hygiene.

-- ── 1. dead weight ──────────────────────────────────────────────────────────────
drop index if exists public.sos_smi_fallback_brick_idx;
drop index if exists public.sos_smi_exact_customer_idx;

-- ── 2. foreign keys without a covering index ────────────────────────────────────
create index if not exists deductions_publication_lines_candidate_idx
  on public.deductions_publication_lines (candidate_id);
create index if not exists deductions_publication_lines_category_idx
  on public.deductions_publication_lines (category);
create index if not exists deductions_publication_lines_decision_idx
  on public.deductions_publication_lines (decision_id);

create index if not exists deductions_publications_superseded_by_idx
  on public.deductions_publications (superseded_by_publication_id);

create index if not exists direct_order_pharmacy_validations_request_idx
  on public.direct_order_pharmacy_validations (request_id);

create index if not exists early_birds_audit_candidate_idx
  on public.early_birds_audit (candidate_id);

create index if not exists early_birds_candidates_employee_hr_id_idx
  on public.early_birds_candidates (employee_hr_id);

create index if not exists early_birds_decisions_decided_by_idx
  on public.early_birds_decisions (decided_by);

create index if not exists early_birds_national_winners_employee_hr_id_idx
  on public.early_birds_national_winners (employee_hr_id);
create index if not exists early_birds_national_winners_winner_idx
  on public.early_birds_national_winners (winner_id);

create index if not exists early_birds_period_snapshots_manager_hr_id_idx
  on public.early_birds_period_snapshots (manager_hr_id);
create index if not exists early_birds_period_snapshots_superseded_by_idx
  on public.early_birds_period_snapshots (superseded_by_snapshot_id);

create index if not exists early_birds_winners_candidate_idx
  on public.early_birds_winners (candidate_id);
create index if not exists early_birds_winners_confirmed_by_idx
  on public.early_birds_winners (confirmed_by);
create index if not exists early_birds_winners_decision_idx
  on public.early_birds_winners (decision_id);
create index if not exists early_birds_winners_employee_hr_id_idx
  on public.early_birds_winners (employee_hr_id);
create index if not exists early_birds_winners_manager_hr_id_idx
  on public.early_birds_winners (manager_hr_id);
create index if not exists early_birds_winners_revoked_by_idx
  on public.early_birds_winners (revoked_by);
