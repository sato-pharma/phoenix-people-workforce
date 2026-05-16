import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const vacationRouteSource = readFileSync(
  new URL("../app/api/employee-portals/vacation-requests/route.ts", import.meta.url),
  "utf8",
);

function assertContains(pattern: RegExp, message: string) {
  assert.match(vacationRouteSource, pattern, message);
}

export function runEmployeePortalVacationRequestRouteTests() {
  assertContains(
    /\.ilike\(column,\s*candidate\)/i,
    "employee portal vacation route must use case-tolerant employee ID matching.",
  );
  assertContains(
    /for\s*\(const column of \["hr_id",\s*"employee_hr_id"\] as const\)/i,
    "employee portal vacation route must check both hr_id and employee_hr_id when resolving the employee record.",
  );
  assertContains(
    /\.select\("full_name,hire_date,hr_id,work_email,area_id,line_id,team_id,areas\(name\),lines\(name\),teams\(name\)"\)/i,
    "employee portal vacation route must not require a non-portable employee_hr_id column in the employee profile select list.",
  );
  assertContains(
    /if\s*\(column === "employee_hr_id" && hasMissingColumnError\(result\.error,\s*"employee_hr_id"\)\)\s*\{\s*continue;\s*\}/i,
    "employee portal vacation route must tolerate environments where employees.employee_hr_id does not exist.",
  );
  assertContains(
    /getEmployeeDirectory\(\{\s*pageSize:\s*-1\s*\}\)/i,
    "employee portal vacation route must fall back to the employee directory when the leave-specific employee row is missing.",
  );
}
