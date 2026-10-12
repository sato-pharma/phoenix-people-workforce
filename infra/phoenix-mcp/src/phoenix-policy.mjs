// Build-time imports of the EXISTING pure policies, never a fork of business rules.
// build.mjs replaces administrative IO with a throwing implementation and removes framework caches.
export { permissionMatrix, createAccessContext, filterEmployeesForAccess, getSalesScope } from '../../../src/lib/auth/permissions.ts';
export { isActiveDirectoryEmployee } from '../../../src/lib/employees/employee-directory.ts';
export { isEmploymentAccessRevoked } from '../../../src/lib/auth/session-lifecycle.ts';
export { seatKeysOfActiveEmployees,reconcileVacancyRowsAgainstOccupancy } from '../../../src/lib/reports/organogram.ts';
export { stripRestrictedColumns } from '../../../src/lib/sales/monthly-closing-portal.ts';
