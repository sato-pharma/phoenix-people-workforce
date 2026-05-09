-- Phase 4 unused-index review workbook for Phoenix HR.
--
-- This file is intentionally review-oriented.
-- Do not turn the candidate DROP statements on by default.
-- Supabase's unused-index advisor is a heuristic over recent stats, and this
-- project is small enough that many valid indexes will show as unused.
--
-- Keep by default:
-- - all FK-support indexes
-- - auth / lockout / abuse-protection indexes
-- - queue / retry-processing indexes
-- - newly added indexes that have not seen enough workload yet

-- ---------------------------------------------------------------------------
-- Inspect current usage before making any drop decision
-- ---------------------------------------------------------------------------

select
  s.schemaname,
  s.relname as table_name,
  s.indexrelname as index_name,
  s.idx_scan,
  s.idx_tup_read,
  s.idx_tup_fetch,
  pg_size_pretty(pg_relation_size(s.indexrelid)) as index_size
from pg_stat_user_indexes s
join pg_index i on i.indexrelid = s.indexrelid
where s.schemaname = 'public'
order by s.idx_scan asc, pg_relation_size(s.indexrelid) desc;

-- ---------------------------------------------------------------------------
-- Candidate business-query indexes to review later
-- Keep these for now unless repeated advisor passes and query analysis show
-- they are truly dead.
-- ---------------------------------------------------------------------------

-- app_auth_users_role_idx
-- idx_sales_targets_employee_hr_id
-- idx_sales_targets_manager_hr_id
-- employee_resignations_last_working_date_idx
-- idx_lines_department_id
-- idx_positions_org
-- idx_employees_org
-- idx_position_vacancies_org
-- idx_notification_events_category
-- idx_notification_events_employee_hr_id
-- idx_notification_events_scheduled_for
-- idx_sales_target_batches_period
-- idx_sales_targets_batch_id
-- idx_sales_audit_logs_batch_id
-- user_access_profiles_hr_id_idx
-- user_access_profiles_role_idx
-- job_offers_expires_at_idx
-- job_offers_candidate_email_idx
-- salary_flags_severity_idx
-- position_vacancies_status_idx
-- position_vacancies_department_idx
-- employees_status_idx
-- employee_compensation_hr_mode_idx
-- salary_batches_period_idx
-- salary_batches_status_idx
-- salary_records_line_idx
-- salary_records_area_idx
-- employee_history_hr_id_idx
-- employee_history_type_idx
-- user_access_profiles_manager_hr_id_idx
-- sales_records_link_status_idx

-- ---------------------------------------------------------------------------
-- Must-keep indexes even if advisor says "unused"
-- ---------------------------------------------------------------------------

-- app_auth_users_locked_until_idx
-- app_auth_users_login_lockout_idx
-- auth_login_attempts_login_ip_idx
-- notification_outbox_status_next_attempt_idx
-- notification_outbox_created_at_idx
-- thread_members_user_id_idx
-- messages_thread_id_created_at_idx
-- all FK-support indexes created in the phase-4 remediation batch

-- ---------------------------------------------------------------------------
-- Commented candidate drops for manual review only
-- Uncomment one by one only after repeated advisor passes and workload checks.
-- ---------------------------------------------------------------------------

-- drop index if exists public.idx_sales_audit_logs_batch_id;
-- drop index if exists public.idx_sales_target_batches_period;
-- drop index if exists public.idx_sales_targets_batch_id;
-- drop index if exists public.idx_sales_targets_employee_hr_id;
-- drop index if exists public.idx_sales_targets_manager_hr_id;
-- drop index if exists public.idx_notification_events_category;
-- drop index if exists public.idx_notification_events_employee_hr_id;
-- drop index if exists public.idx_notification_events_scheduled_for;
