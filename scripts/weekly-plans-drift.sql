-- Weekly Plans drift detector — run weekly against production (read-only).
-- Every query must return 0 rows. Non-zero rows = impossible state → investigate before next deploy.
-- Owner: HR Operations. Scheduled via the daily cron drift-detector job (PR 4 of the 10/10 plan).

-- D1: status='final_approved' but no timestamp
SELECT id FROM employee_plan_headers
WHERE status = 'final_approved' AND final_approved_at IS NULL;

-- D2: advanced status but no submitted_at
SELECT id FROM employee_plan_headers
WHERE status IN (
  'submitted', 'manager_approved', 'manager_rejected', 'manager_returned',
  'ceo_approved', 'ceo_rejected', 'ceo_returned', 'final_approved', 'hr_acknowledged'
)
  AND submitted_at IS NULL;

-- D3: manager decision actor/timestamp XOR (one set, other NULL)
SELECT id FROM employee_plan_headers
WHERE (manager_decision_by_hr_id IS NULL) <> (manager_decision_at IS NULL);

-- D4: orphan plans awaiting manager decision with NULL/missing/terminated manager
SELECT h.id, h.employee_hr_id, h.manager_hr_id, e.employment_status
FROM employee_plan_headers h
LEFT JOIN employees e ON UPPER(e.hr_id) = UPPER(h.manager_hr_id)
WHERE h.status IN ('submitted', 'manager_returned', 'ceo_returned')
  AND (h.manager_hr_id IS NULL OR e.hr_id IS NULL OR e.employment_status NOT IN ('active', 'on_leave'));

-- D5: header status mismatched with the most recent decision row
SELECT h.id, h.status AS header_status, d.to_status AS last_decision_to_status
FROM employee_plan_headers h
JOIN LATERAL (
  SELECT to_status FROM employee_plan_decisions d
  WHERE d.plan_id = h.id ORDER BY created_at DESC LIMIT 1
) d ON true
WHERE h.status <> d.to_status;

-- D6: hr_acknowledged header but no acknowledgement row
SELECT h.id FROM employee_plan_headers h
LEFT JOIN employee_plan_hr_acknowledgements a ON a.plan_id = h.id
WHERE h.status = 'hr_acknowledged' AND a.id IS NULL;
