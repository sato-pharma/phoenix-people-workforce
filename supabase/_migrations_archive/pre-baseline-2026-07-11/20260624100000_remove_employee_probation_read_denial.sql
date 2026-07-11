-- Fix PHOENIX-8: Remove the role_permission_overrides row that denies
-- Employee/probation/read. The default permission matrix grants this, and the
-- employee portal probation page requires it. Without this permission,
-- Employees see "Forbidden: Employee cannot read probation."
DELETE FROM role_permission_overrides
WHERE role_name = 'Employee'
  AND resource  = 'probation'
  AND action    = 'read'
  AND is_allowed = false;