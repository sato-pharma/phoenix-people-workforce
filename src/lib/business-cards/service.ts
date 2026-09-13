import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";

import { cardFieldsFor } from "./card-content.ts";
import type { BusinessCardFields } from "./card-content.ts";

export type BusinessCardEmployee = {
  areaName: string | null;
  /** What the card prints for this person before anyone edits it on screen. */
  fields: BusinessCardFields;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  name: string;
  regionName: string | null;
};

/**
 * Everyone a card can be printed for: the active staff list, the same people the employee directory
 * counts as current. A leaver has no card to hand out, so they are not offered.
 */
export async function listBusinessCardEmployees(): Promise<BusinessCardEmployee[]> {
  const { employees } = await getEmployeeDirectory();
  return employees
    .filter(isActiveDirectoryEmployee)
    .map((employee) => ({
      areaName: employee.areaName,
      fields: cardFieldsFor(employee),
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      lineName: employee.lineName,
      name: employee.displayName,
      regionName: employee.regionName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
