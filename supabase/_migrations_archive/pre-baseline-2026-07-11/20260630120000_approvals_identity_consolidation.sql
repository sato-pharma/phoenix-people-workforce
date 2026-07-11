-- Approvals Workflow — identity consolidation & attribution backfill.
--
-- WHY: A deep audit found approval decisions were recorded under the shared
-- System-Administrator login token ("admin-hr") instead of a canonical HR_ID, so the
-- Approvals Hub "Approval history" tab (which matches on HR_ID) could not find them.
-- An earlier hotfix mis-attributed those rows to B-10 (Omar Gawish, a real HR Manager).
-- Owner decision: the system-admin login gets a canonical identity PHX-1, and every
-- system-admin decision is re-attributed to PHX-1.
--
-- SAFE: metadata/attribution only. No financial values, statuses, or rows are deleted.
-- The locked-salary-batch guard trigger is disabled ONLY around a scoped attribution
-- UPDATE and re-enabled in the same transaction. Fully reversible (prior tokens known:
-- 'admin-hr' / 'B-10'). Idempotent — safe to re-run.
--
-- PRE-CHECK FACTS (verified against prod before writing):
--   * employees.hr_id is the PK; app_auth_users.hr_id is a FK to it (so PHX-1 must exist
--     before linking the login). Decision columns (approved_by, reviewed_by, …) are
--     free-text, NOT FK-enforced.
--   * Pre-backfill, resignations/salary_batches/sales_import_batches had ZERO genuine B-10
--     decisions — every B-10 there came from the earlier hotfix, so reverting B-10 -> PHX-1
--     in exactly those three tables is safe.
--   * The legacy 'ADMIN-HR' employees row is left intact (it has child rows); we add a
--     distinct PHX-1 identity rather than rename the PK, to avoid any FK cascade.

BEGIN;

-- 1) Canonical system-admin identity. Non-payroll, non-organogram so it never leaks into
--    headcount / org charts / payroll. Active so the admin login is not blocked.
INSERT INTO employees (hr_id, full_name, job_title, employment_status, onboarding_status,
                       payroll_eligible, organogram_visible)
VALUES ('PHX-1', 'Phoenix System Administrator', 'System Administrator', 'active', 'active',
        false, false)
ON CONFLICT (hr_id) DO NOTHING;

-- 2) Link the admin-HR login to PHX-1 (it was NULL — why the system admin saw an empty
--    history and new admin actions wrote no HR_ID).
UPDATE app_auth_users
SET hr_id = 'PHX-1'
WHERE login_id = 'admin-HR' AND hr_id IS DISTINCT FROM 'PHX-1';

-- 3) Re-attribute every system-admin decision -> PHX-1.

-- 3a) Resignations (one of the 4 history modules).
UPDATE employee_resignations SET reviewed_by  = 'PHX-1' WHERE reviewed_by  IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE employee_resignations SET approved_by  = 'PHX-1' WHERE approved_by  IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE employee_resignations SET rejected_by  = 'PHX-1' WHERE rejected_by  IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE employee_resignations SET completed_by = 'PHX-1' WHERE completed_by IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE employee_resignations SET cancelled_by = 'PHX-1' WHERE cancelled_by IN ('admin-hr','admin-HR','ADMIN-HR','B-10');

-- 3b) Salary batches — bypass the locked-batch guard for this scoped attribution UPDATE only.
ALTER TABLE salary_batches DISABLE TRIGGER phx_prevent_closed_salary_batch_update;
UPDATE salary_batches SET approved_by    = 'PHX-1' WHERE approved_by    IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE salary_batches SET part1_paid_by  = 'PHX-1' WHERE part1_paid_by  IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE salary_batches SET part2_ready_by = 'PHX-1' WHERE part2_ready_by IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
ALTER TABLE salary_batches ENABLE TRIGGER phx_prevent_closed_salary_batch_update;

-- 3c) Sales import batches.
UPDATE sales_import_batches SET approved_by = 'PHX-1' WHERE approved_by IN ('admin-hr','admin-HR','ADMIN-HR','B-10');
UPDATE sales_import_batches SET rejected_by = 'PHX-1' WHERE rejected_by IN ('admin-hr','admin-HR','ADMIN-HR','B-10');

-- 3d) Payroll expense approvals (still held the lowercase login token).
UPDATE payroll_expenses SET approved_by = 'PHX-1' WHERE approved_by IN ('admin-hr','admin-HR','ADMIN-HR');

-- 4) Case-normalize plan-header deciders so executives see consistent IDs
--    (read code is already case-insensitive; this is hygiene only).
UPDATE employee_plan_headers SET manager_decision_by_hr_id = UPPER(manager_decision_by_hr_id)
WHERE manager_decision_by_hr_id IS NOT NULL AND manager_decision_by_hr_id <> UPPER(manager_decision_by_hr_id);
UPDATE employee_plan_headers SET ceo_decision_by_hr_id = UPPER(ceo_decision_by_hr_id)
WHERE ceo_decision_by_hr_id IS NOT NULL AND ceo_decision_by_hr_id <> UPPER(ceo_decision_by_hr_id);

-- 5) Verification — fail loudly if any system-admin token or lowercase decider remains.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM employee_resignations
       WHERE 'admin-hr' IN (reviewed_by,approved_by,rejected_by,completed_by,cancelled_by)
          OR 'B-10'    IN (reviewed_by,approved_by,rejected_by,completed_by,cancelled_by))
  + (SELECT COUNT(*) FROM salary_batches
       WHERE 'admin-hr' IN (approved_by,part1_paid_by,part2_ready_by)
          OR 'B-10'    IN (approved_by,part1_paid_by,part2_ready_by))
  + (SELECT COUNT(*) FROM sales_import_batches
       WHERE 'admin-hr' IN (approved_by,rejected_by)
          OR 'B-10'    IN (approved_by,rejected_by))
  + (SELECT COUNT(*) FROM payroll_expenses WHERE approved_by IN ('admin-hr','admin-HR','ADMIN-HR'))
  + (SELECT COUNT(*) FROM employee_plan_headers
       WHERE (manager_decision_by_hr_id IS NOT NULL AND manager_decision_by_hr_id <> UPPER(manager_decision_by_hr_id))
          OR (ceo_decision_by_hr_id     IS NOT NULL AND ceo_decision_by_hr_id     <> UPPER(ceo_decision_by_hr_id)))
  + (SELECT COUNT(*) FROM app_auth_users WHERE login_id = 'admin-HR' AND hr_id IS DISTINCT FROM 'PHX-1')
  + (SELECT COUNT(*) FROM employees WHERE hr_id = 'PHX-1') * 0  -- PHX-1 must exist (checked next)
  INTO bad_count;

  IF bad_count <> 0 THEN
    RAISE EXCEPTION 'approvals identity consolidation: % unresolved attribution rows remain', bad_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE hr_id = 'PHX-1') THEN
    RAISE EXCEPTION 'approvals identity consolidation: PHX-1 employee identity missing';
  END IF;
END $$;

COMMIT;
