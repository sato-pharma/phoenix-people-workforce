import assert from "node:assert/strict";

import { filterHiringDocumentsForAccess } from "../src/lib/hiring-documents/service.ts";
import type { HiringDocumentsDashboardData } from "../src/lib/hiring-documents/types.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

// Head Office audit regression guard (2026-07-25): Talent Acquisition is the primary
// user of the Hiring Documents dashboard (her recruiting/onboarding tool) and already
// gets the equivalent company-wide bypass in every sibling HR domain
// (isCompanyResignationReader, isCompanyContractReader, canSeeAllRecruitment) — without
// it here, filterHiringDocumentsForAccess fell through to canSeeHrScopedRecord's
// self-only default and would have shown her only her own employee row.
function makeEmployee(hrId: string, managerHrId: string | null) {
  return {
    hrId,
    fullName: `Employee ${hrId}`,
    managerHrId,
    employmentStatus: "Active",
    hireDate: null,
    jobTitle: "Medical Rep",
    lineName: "Pedia",
    managerName: null,
    notes: null,
    documents: {},
  };
}

export function runHiringDocumentsAccessTests() {
  const dashboard: HiringDocumentsDashboardData = {
    documents: [],
    employees: [makeEmployee("MR-1", "PM-1"), makeEmployee("MR-2", "PM-2")],
    summary: {
      completeDocuments: 0,
      dueDocuments: 0,
      employees: 2,
      missingDocuments: 0,
      pendingDocuments: 0,
      submittedDocuments: 0,
      totalDocumentSlots: 0,
    },
  };

  const taContext: AccessContext = { hrId: "TA-1", loginId: "TA-1", role: "HR Advisory", scope: "self", source: "session" };
  const taFiltered = filterHiringDocumentsForAccess(dashboard, taContext);
  assert.equal(taFiltered.employees.length, 2, "HR Advisory sees every employee, not just her own scoped subset");
  assert.deepEqual(taFiltered, dashboard, "HR Advisory gets the dashboard back unchanged (company-wide bypass)");

  // Regression guard: an ordinary role without HR authority is still scoped to self-only.
  const repContext: AccessContext = { hrId: "MR-1", loginId: "MR-1", role: "Medical Rep", scope: "self", source: "session" };
  const repFiltered = filterHiringDocumentsForAccess(dashboard, repContext);
  assert.equal(repFiltered.employees.length, 1, "an ordinary role still only sees its own row, not the company-wide bypass");
  assert.equal(repFiltered.employees[0].hrId, "MR-1", "the one visible row is the caller's own");

  const superAdminContext: AccessContext = { hrId: "SA-1", loginId: "SA-1", role: "Super Admin", scope: "system", source: "session" };
  assert.deepEqual(
    filterHiringDocumentsForAccess(dashboard, superAdminContext),
    dashboard,
    "Super Admin (system scope) keeps the existing unrestricted bypass",
  );
}
