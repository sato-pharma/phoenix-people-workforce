-- Fixes PHOENIX-A by restoring the default permission for Employees to create outstations.
DELETE FROM public.role_permission_overrides
WHERE
  role_name = 'Employee' AND
  resource = 'outstation' AND
  action = 'create';