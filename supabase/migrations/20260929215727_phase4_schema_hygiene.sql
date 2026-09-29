-- Schema hygiene: four findings from the 2026-09-29 production audit, each fixed at its cause.
--
-- 🔴 A FIFTH AND A SIXTH ARE DELIBERATELY NOT HERE. Both are at the bottom of this file with
-- the measurement that stopped them, because "why this was not done" is the part a later
-- session needs and the part that never survives.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REVOKE the browser-role grants on nine views.
--
-- 🔴 THESE ARE NOT "MISLEADING SELECT GRANTS", WHICH IS HOW THE AUDIT FIRST READ THEM.
-- Eight of the nine grant `anon` — the PUBLIC key, hardcoded in ci.yml — the full set:
-- DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE. On views including
-- v_employee_portal_payslips, v_employee_portal_salary_history and
-- v_payroll_eligible_employees.
--
-- They are inert TODAY for exactly one reason: every one of them is `security_invoker = true`,
-- so a read or a write is re-checked against the caller's own rights on the tables underneath,
-- and `anon` has none. Probed with the live anon key on 2026-09-29, all nine answer 401/42501.
--
-- That is a safety catch, not a lock. Anyone who drops `security_invoker` from one of these
-- views — or restores it from a backup that predates it — hands the public key a payroll view.
-- Revoking removes the loaded gun instead of relying on the catch.
--
-- SAFE because nothing working can depend on a grant that already answers 401: the portal runs
-- server-side on the service-role client, and `authenticated` KEEPS its grants here. Only
-- `anon` is touched. Reversible with a GRANT if ever needed.

revoke all on public.employee_linkage_health          from anon;
revoke all on public.employee_linkage_health_summary  from anon;
revoke all on public.source_of_sales_block_groups     from anon;
revoke all on public.v_active_organogram              from anon;
revoke all on public.v_employee_portal_payslips       from anon;
revoke all on public.v_employee_portal_salary_history from anon;
revoke all on public.v_employee_portal_sales          from anon;
revoke all on public.v_hr_id_orphan_audit             from anon;
revoke all on public.v_payroll_eligible_employees     from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PIN search_path on the ten unpinned functions in `public`.
--
-- An unpinned function resolves unqualified names through the CALLER's search_path, so a
-- caller who puts a schema of their own in front can substitute a table or an operator.
--
-- Severity, stated honestly rather than dressed up: all ten are SECURITY INVOKER, so a
-- hijacked path runs with the caller's OWN rights, not the owner's. Measured 2026-09-29, ZERO
-- SECURITY DEFINER functions in `public` are unpinned — the dangerous class is already clean.
-- Six of the ten return `trigger`, which PostgREST does not expose as an RPC at all. That
-- leaves four reachable functions, of which one (phx_custody_item_values_valid) is executable
-- by anon.
--
-- So this is tidying a warn, not closing a breach — and it is worth doing because the advisor
-- baseline recorded this category as REMEDIATED in July and it came back ten-fold unnoticed.
--
-- `public, pg_temp` is the house form. pg_temp last is deliberate: leaving it out entirely
-- would let a caller's temp schema still win for unqualified names in some paths.

alter function public.phx_fold_customer_name(text)                            set search_path = public, pg_temp;
alter function public.phx_squash_customer_name(text)                          set search_path = public, pg_temp;
alter function public.phx_custody_item_values_valid(jsonb)                    set search_path = public, pg_temp;
alter function public.phx_customer_channel(text, text, text, text, text, jsonb) set search_path = public, pg_temp;
alter function public.phx_refuse_audit_trail_change()                         set search_path = public, pg_temp;
alter function public.ats_whatsapp_screening_questions_immutable_key()        set search_path = public, pg_temp;
alter function public.hiring_pack_document_field_history_is_append_only()     set search_path = public, pg_temp;
alter function public.market_awareness_touch_updated_at()                     set search_path = public, pg_temp;
alter function public.market_awareness_clear_hold_on_exit()                   set search_path = public, pg_temp;
alter function public.v2_freeze_request_code()                                set search_path = public, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AUTOVACUUM on four hot tables that have NEVER been vacuumed automatically.
--
-- 🔴 The tell is not the dead-tuple count, it is `last_autovacuum IS NULL` on all four while a
-- neighbour that IS tuned (ireports360_visits) was autovacuumed tonight. They sit just UNDER
-- the 20% default threshold and therefore never trigger — measured 2026-09-29:
--
--     ireports360_plan_entries   188,834 live   30,637 dead   16.2%   never
--     activity_events             72,383 live   12,280 dead   17.0%   never
--     notification_deliveries     49,810 live    6,686 dead   13.4%   never
--     crm_contacts                19,121 live    3,615 dead   18.9%   never
--
-- A table parked at 17% dead forever is paying that on every sequential scan and never
-- reclaiming it. Same settings already proven on ireports360_visits in the 2026-07-11 baseline.

alter table public.ireports360_plan_entries set (
  autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = 1000);
alter table public.activity_events set (
  autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = 1000);
alter table public.notification_deliveries set (
  autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = 1000);
alter table public.crm_contacts set (
  autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = 1000);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MOVE four point-in-time snapshot tables out of `public`.
--
-- `public` is the ONLY schema PostgREST serves. None of these four is reachable today, so this
-- is placement rather than exposure — but that protection rests entirely on grants staying
-- exactly as they are, which is the assumption item 1 above just found to be wrong elsewhere.
-- Procedure and rationale: docs/security/backup-table-placement.md.
--
-- -- SAFE: `set schema` MOVES the table; no data is copied, dropped or rewritten, and the move
-- -- is reversible with the inverse statement. Verified 2026-09-29 that no foreign key, view or
-- -- browser grant references any of the four.
--
-- Grouped by the date in their own names, so the retention policy shipped earlier today
-- (scripts/audit-backup-schemas.mjs, docs/security/backup-schema-retention.md) can age them
-- out on the 90-day rule instead of them sitting in `public` for ever.

create schema if not exists preimage_backup_20260928;
revoke all on schema preimage_backup_20260928 from public, anon, authenticated;

create schema if not exists preimage_backup_20260929;
revoke all on schema preimage_backup_20260929 from public, anon, authenticated;

alter table public.outstation_origin_preimage_20260928     set schema preimage_backup_20260928;
alter table public.weaam_distance_preimage_20260928        set schema preimage_backup_20260928;
alter table public.weaam_residence_coord_preimage_20260928 set schema preimage_backup_20260928;
alter table public.do_order_repoint_backup_20260929        set schema preimage_backup_20260929;

comment on schema preimage_backup_20260928 is
  'Pre-images taken 2026-09-28, relocated out of public 2026-09-29. Retention: docs/security/backup-schema-retention.md.';
comment on schema preimage_backup_20260929 is
  'Pre-image taken 2026-09-29, relocated out of public 2026-09-29. Retention: docs/security/backup-schema-retention.md.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 NOT DONE HERE, AND WHY. Both were in the plan; both are refused on measurement.
--
-- (5) MOVING pg_trgm OUT OF `public` WOULD HAVE BROKEN A LIVE FEATURE.
--     The plan said this was safe because indexes bind to the opclass OID and survive. The two
--     trigram indexes on source_of_sales_customer_map do survive, and both read indisvalid.
--     But `public.phx_suggest_direct_order_pharmacies` — the direct-order pharmacy suggester —
--     carries `search_path=""` and calls **`public.similarity(...)`, schema-qualified**. Move
--     the extension and that call resolves to nothing the moment the function next runs. It is
--     a SQL function, so it would fail at call time, in production, on a live desk flow.
--     Doing it properly means moving the extension AND rewriting every qualified reference in
--     that function in one migration, then CALLING it to prove it. That is a change with its
--     own blast radius and it does not belong bundled with four unrelated tidyings at 01:00.
--     It stays recorded in docs/security/supabase-advisor-baseline.md as OPEN.
--
-- (6) THE FIFTH SNAPSHOT TABLE IN `public` IS ANOTHER SESSION'S, CREATED MINUTES AGO.
--     `public.hiring_document_definitions_pre_20260930` appeared while this work was in
--     progress. It is a live session's rollback pre-image; moving it could break that session's
--     recovery path mid-flight, and AGENTS.md §5 is explicit that changes you did not create
--     are not yours to relocate. It is left exactly where it is, and the daily check will keep
--     naming it until its owner retires it — which is the check working, not a defect.

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK for item 1, captured from the live catalogue immediately before the revoke.
-- Recorded here because a revoke is only reversible if someone wrote down what was there,
-- and "SELECT" would have been the wrong guess for eight of these nine.
--
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.employee_linkage_health to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.employee_linkage_health_summary to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.source_of_sales_block_groups to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.v_active_organogram to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.v_employee_portal_payslips to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.v_employee_portal_salary_history to anon;
--   grant REFERENCES, SELECT, TRIGGER on public.v_employee_portal_sales to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.v_hr_id_orphan_audit to anon;
--   grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.v_payroll_eligible_employees to anon;
--
-- Rollback for item 4 is the inverse `set schema public` on each of the four tables.
