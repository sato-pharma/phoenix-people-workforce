// Daily Deductions module: who is a Head Office employee, for the "Exclude Head Office employees" view
// filter (view-filters.ts). The one database read that filter needs, made on the server.
//
// 🔴 NO NEW DEFINITION. "Head Office" is the employee master's Head Office LINE, asked through
// `isHeadOfficeRow` (src/lib/reports/organogram.ts): line id 4, else a line named "Head Office" or
// "Office" for a row whose id is missing. It is the same rule the organogram strips the Head Office
// branch by, and the line `cns-line-members.ts` files by its code `head_office`.
//
// It is deliberately NOT `WEEKLY_PLAN_REQUIRED_TITLES` (no-weekly-plan-select.ts). That is an
// allow-list of the two titles that OWE a weekly plan — the Product Manager and the Group Product
// Manager — not a description of Head Office: the CEO, HR, Finance, R&D and the rest of the head office
// are outside it, so filtering by it would leave every one of their deductions on screen.
//
// Leavers are included (`includeInactive`): a leaver's deductions still reach the tally for the days
// before they left, and they are still Head Office for those days.

import { compactDeductionsHrId } from "../deductions/candidate-key.ts";

/**
 * The compact HR ids (the deductions' own key) of every employee on the Head Office line, or `null`
 * when the employee directory cannot be read — never an empty set, which would read as "nobody is Head
 * Office" and leave the filter quietly doing nothing.
 */
export async function loadHeadOfficeEmployeeCompacts(): Promise<Set<string> | null> {
  try {
    const [{ getEmployeeDirectoryRows }, { isHeadOfficeRow }] = await Promise.all([
      import("@/lib/employees/employee-directory"),
      import("@/lib/reports/organogram"),
    ]);
    const rows = await getEmployeeDirectoryRows({ includeInactive: true });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const compacts = new Set<string>();
    for (const row of rows) {
      if (!isHeadOfficeRow({ lineId: row.lineId, lineName: row.lineName })) continue;
      const compact = compactDeductionsHrId(row.hrId);
      if (compact) compacts.add(compact);
    }
    return compacts;
  } catch (error) {
    console.error("[daily-deductions] the Head Office list could not be read:", error);
    return null;
  }
}
