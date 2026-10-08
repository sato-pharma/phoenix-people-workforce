import assert from "node:assert/strict";

import {
  filterHiringDocumentsForAccess,
  selectHiringDocumentEmployee,
} from "../src/lib/hiring-documents/service.ts";
import type { HiringDocumentsDashboardData } from "../src/lib/hiring-documents/types.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

// Head Office audit regression guard (2026-07-25): Talent Acquisition is the primary
// user of the Hiring Documents dashboard (her recruiting/onboarding tool) and already
// gets the equivalent company-wide bypass in every sibling HR domain
// (isCompanyResignationReader, isCompanyContractReader, canSeeAllRecruitment) — without
// it here, filterHiringDocumentsForAccess fell through to canSeeHrScopedRecord's
// self-only default and would have shown her only her own employee row.
//
// HR Operations regression guard (owner instruction, 2026-08-31): Yasmine (HR-009) was
// falling through to that same self-only default and seeing only her own row. Every
// employee must appear to her here, with full read/write.
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
      scannedDocuments: 0,
      submittedDocuments: 0,
      totalDocumentSlots: 0,
    },
  };

  // HR Advisory had the same company-wide bypass until the owner retired the HR Business Partner seat on 2026-10-08; a stray
  // holder of the retired key falls through to the self-scoped default like any other role.
  const taContext: AccessContext = { hrId: "TA-1", loginId: "TA-1", role: "HR Advisory", scope: "self", source: "session" };
  const taFiltered = filterHiringDocumentsForAccess(dashboard, taContext);
  assert.notEqual(taFiltered.employees.length, dashboard.employees.length, "the retired seat no longer bypasses the scope");

  const hrOpsContext: AccessContext = { hrId: "HR-009", loginId: "HR-009", role: "HR Operations", scope: "company", source: "session" };
  const hrOpsFiltered = filterHiringDocumentsForAccess(dashboard, hrOpsContext);
  assert.equal(hrOpsFiltered.employees.length, 2, "HR Operations sees every employee, not just her own scoped subset");
  assert.deepEqual(hrOpsFiltered, dashboard, "HR Operations gets the dashboard back unchanged (company-wide bypass)");

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

  // ── the single-employee form, behind the SAME boundary ──────────────────────
  //
  // The employee details panel asks for one person's row rather than pulling the whole board
  // (`/api/hiring-documents?hrId=`). That is a lookup by id, which is exactly the shape that turns
  // a scope boundary into a leak when the scoping is left to the caller — so
  // `selectHiringDocumentEmployee` takes the ACCESS CONTEXT and filters itself, and these cases pin
  // that it really does.

  assert.equal(
    selectHiringDocumentEmployee(dashboard, superAdminContext, "MR-2").employee?.hrId,
    "MR-2",
    "a Super Admin gets the row they asked for",
  );

  // 🔴 THE ONE THAT MATTERS. MR-1 may see only their own row, and MR-2 is a real employee with a
  // real HR_ID. Asking for them by id must answer null, not their documents.
  assert.equal(
    selectHiringDocumentEmployee(dashboard, repContext, "MR-2").employee,
    null,
    "an employee outside the caller's scope must read as absent — naming an id is not authorisation",
  );
  assert.equal(
    selectHiringDocumentEmployee(dashboard, repContext, "MR-1").employee?.hrId,
    "MR-1",
    "the caller's own row is still returned",
  );

  // An unknown id and a blank one answer the same way as an out-of-scope one: telling them apart
  // would say whether somebody the caller may not see exists at all.
  for (const hrId of [null, "", "ZZ-99"]) {
    assert.equal(
      selectHiringDocumentEmployee(dashboard, repContext, hrId).employee,
      null,
      `an unresolvable hr id (${JSON.stringify(hrId)}) reads as absent`,
    );
  }

  // Case is not identity: the panel passes the HR_ID as the directory spells it, and the checklist
  // canonicalises its own.
  assert.equal(
    selectHiringDocumentEmployee(dashboard, superAdminContext, "mr-1").employee?.hrId,
    "MR-1",
    "a differently-cased HR_ID is the same person",
  );

  // The definitions always come back, even when the person does not — the panel needs them to tell
  // "nothing to show" from "nothing to ask".
  assert.deepEqual(
    selectHiringDocumentEmployee(dashboard, repContext, "MR-2").documents,
    dashboard.documents,
    "the document definitions are returned whether or not the person is visible",
  );
}
