-- Fix PHOENIX-16: Remove the role_permission_overrides row that denies
-- Employee/payroll/read. The default permission matrix grants this, and the
-- admin payroll page requires it. Without this permission,
-- Employees see "Forbidden: Employee cannot read payroll."
DELETE FROM role_permission_overrides
WHERE role_name = 'Employee'
  AND resource  = 'payroll'
  AND action    = 'read'
  AND is_allowed = false;