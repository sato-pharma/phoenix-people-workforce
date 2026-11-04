import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";

import { applyRequestedCard, cardFieldsFor } from "./card-content.ts";
import type { BusinessCardFields } from "./card-content.ts";
import { listLatestCardRequestsByPerson } from "./request-service.ts";
import type { LatestCardRequest } from "./request-service.ts";

export type BusinessCardEmployee = {
  areaName: string | null;
  /**
   * What the card prints for this person before anyone edits it on screen: the record, with the name
   * and mobile of their own latest request laid over it (see `requested`).
   */
  fields: BusinessCardFields;
  /** Date only (`YYYY-MM-DD`) — the screen filters by its month so new hires are easy to find. */
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  name: string;
  regionName: string | null;
  /** The employee's own latest request, when they sent one — its lines are already in `fields`. */
  requested: LatestCardRequest | null;
};

export type BusinessCardEmployeeList = {
  employees: BusinessCardEmployee[];
  /** True when the employees' own requests could not be read — the cards then show the record alone. */
  requestsUnread: boolean;
};

/**
 * Everyone a card can be printed for: the active staff list, the same people the employee directory
 * counts as current. A leaver has no card to hand out, so they are not offered.
 *
 * Each card starts from what the employee set on their own page (owner, 2026-11-04: their edits used
 * to vanish here, because this screen read the record alone). The screen and the file it downloads
 * both come through this one function, so what HR sees is what prints.
 */
export async function listBusinessCardEmployees(): Promise<BusinessCardEmployeeList> {
  const [{ employees }, requests] = await Promise.all([
    getEmployeeDirectory(),
    listLatestCardRequestsByPerson().catch((error: unknown) => {
      logError("Business card requests could not be read for the HR screen", {
        error,
        labels: { event: "business_card_requests_overlay_unread" },
      });
      return null;
    }),
  ]);
  return {
    employees: employees
      .filter(isActiveDirectoryEmployee)
      .map((employee) => {
        const requested = requests?.get(canonicalHrIdKey(employee.hrId) ?? "") ?? null;
        return {
          areaName: employee.areaName,
          fields: applyRequestedCard(cardFieldsFor(employee), requested),
          hireDate: employee.hireDate,
          hrId: employee.hrId,
          jobTitle: employee.jobTitle,
          lineName: employee.lineName,
          name: employee.displayName,
          regionName: employee.regionName,
          requested,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    requestsUnread: requests === null,
  };
}
