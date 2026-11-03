// ─────────────────────────────────────────────────────────────────────────────────────────────
// The server's half of the record gaps list. It reads the Employee Master's own directory through the
// viewer's own filter and the master's own rule for who is active, so the two screens cannot disagree
// about who is here. Nothing else leaves this file but standings (see record-gaps-logic.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { filterEmployeeDirectoryForAccess, type AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { buildEmployeeRecordGaps, type EmployeeRecordGapsData } from "@/lib/employees/record-gaps-logic";

export async function getEmployeeRecordGaps(access: AccessContext): Promise<EmployeeRecordGapsData> {
  const directory = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);
  return buildEmployeeRecordGaps(directory.employees.filter(isActiveDirectoryEmployee), todayInCairo());
}
