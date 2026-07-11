-- phx_weekly_plans_drift_check() — read-only RPC that runs the 6 drift detector
-- queries (D1-D6) and returns anomaly counts as a JSON object.  Called daily by the
-- app server after the /api/notifications/daily cron fires; never called by anon/authed.
-- Expected return on a clean system: {"D1":0,"D2":0,"D3":0,"D4":0,"D5":0,"D6":0}

CREATE OR REPLACE FUNCTION public.phx_weekly_plans_drift_check()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d1_count integer := 0;
  d2_count integer := 0;
  d3_count integer := 0;
  d4_count integer := 0;
  d5_count integer := 0;
  d6_count integer := 0;
BEGIN
  -- D1: final_approved but no timestamp
  SELECT COUNT(*) INTO d1_count
  FROM employee_plan_headers
  WHERE status = 'final_approved' AND final_approved_at IS NULL;

  -- D2: advanced status but no submitted_at
  SELECT COUNT(*) INTO d2_count
  FROM employee_plan_headers
  WHERE status IN (
    'submitted', 'manager_approved', 'manager_rejected', 'manager_returned',
    'ceo_approved', 'ceo_rejected', 'ceo_returned', 'final_approved', 'hr_acknowledged'
  ) AND submitted_at IS NULL;

  -- D3: manager decision actor/timestamp XOR
  SELECT COUNT(*) INTO d3_count
  FROM employee_plan_headers
  WHERE (manager_decision_by_hr_id IS NULL) <> (manager_decision_at IS NULL);

  -- D4: orphan plans awaiting manager with NULL/missing/terminated manager
  SELECT COUNT(*) INTO d4_count
  FROM employee_plan_headers h
  LEFT JOIN employees e ON UPPER(e.hr_id) = UPPER(h.manager_hr_id)
  WHERE h.status IN ('submitted', 'manager_returned', 'ceo_returned')
    AND (h.manager_hr_id IS NULL OR e.hr_id IS NULL
         OR e.employment_status NOT IN ('active', 'on_leave'));

  -- D5: header status mismatched with most recent decision row
  SELECT COUNT(*) INTO d5_count
  FROM employee_plan_headers h
  JOIN LATERAL (
    SELECT to_status FROM employee_plan_decisions d
    WHERE d.plan_id = h.id ORDER BY created_at DESC LIMIT 1
  ) d ON true
  WHERE h.status <> d.to_status;

  -- D6: hr_acknowledged header but no acknowledgement row
  SELECT COUNT(*) INTO d6_count
  FROM employee_plan_headers h
  LEFT JOIN employee_plan_hr_acknowledgements a ON a.plan_id = h.id
  WHERE h.status = 'hr_acknowledged' AND a.id IS NULL;

  RETURN jsonb_build_object(
    'D1', d1_count,
    'D2', d2_count,
    'D3', d3_count,
    'D4', d4_count,
    'D5', d5_count,
    'D6', d6_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.phx_weekly_plans_drift_check() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phx_weekly_plans_drift_check() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.phx_weekly_plans_drift_check() FROM anon;
GRANT EXECUTE ON FUNCTION public.phx_weekly_plans_drift_check() TO service_role;
