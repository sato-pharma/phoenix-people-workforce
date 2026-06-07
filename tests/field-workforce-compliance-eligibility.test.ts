import { strict as assert } from "node:assert";

import { isFieldWorkforceComplianceEligibleTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  type FieldWorkforceEmployeeInput,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";

function visit(
  agentID: number,
  visitDate: string,
  agentName: string | null,
  doubleID: number | null = null,
): IReports360Visit {
  return {
    agentID,
    agentName,
    ampm: null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    customerName: null,
    doubleID,
    doubleName: doubleID != null ? "Double.Partner" : null,
    id: agentID * 1000 + Number(visitDate.slice(8, 10)),
    saveDate: null,
    visitDate,
    visitType: 0, // regular visit
    visitTypeDescription: "Regular",
  };
}

export function runFieldWorkforceComplianceEligibilityTests() {
  // --- Helper: who is eligible (Sales + Marketing + Training Manager) ---
  for (const eligible of [
    "Medical Representative",
    "medical rep",
    "District Sales Manager",
    "Regional Sales Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "SFE Manager", // appears in the compliance report (excluded from deductions elsewhere)
  ]) {
    assert.equal(
      isFieldWorkforceComplianceEligibleTitle(eligible),
      true,
      `expected "${eligible}" to be eligible`,
    );
  }

  // --- Helper: who is excluded (back-office, system, blank titles) ---
  for (const excluded of [
    "HR Manager",
    "Finance Manager",
    "R And D Manager",
    "Regulatory Affairs",
    "Qppv",
    "Talent Acquisition",
    "Admin Assistant",
    "System Administrator",
    "Office Coordinator",
    "Ceo",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      isFieldWorkforceComplianceEligibleTitle(excluded),
      false,
      `expected "${String(excluded)}" to be excluded`,
    );
  }

  // Multiple title fields: eligibility holds if ANY field qualifies.
  assert.equal(isFieldWorkforceComplianceEligibleTitle("", "Medical Rep"), true);
  assert.equal(isFieldWorkforceComplianceEligibleTitle("Office Coordinator", null), false);

  // --- Matrix builder: every eligible, active employee becomes a row (even with no visits) ---
  const employees: FieldWorkforceEmployeeInput[] = [
    // Eligible rep WITH a visit.
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    // Eligible manager with NO visits at all — must still appear (the "missing managers" fix).
    { crmId: "5", crmUsername: "Mgr.Five", employmentStatus: "active", fullName: "Mgr Five", hireDate: "2024-01-01", hrId: "A-5", jobTitle: "National Sales Manager", positionTitle: null },
    // Manager who ONLY rides along as a double partner — his joint visits must be credited.
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
    // Ineligible role — excluded.
    { crmId: "2", crmUsername: "Admin.Two", employmentStatus: "active", fullName: "Admin Two", hireDate: "2024-01-01", hrId: "A-2", jobTitle: "Admin Assistant", positionTitle: null },
    // Departed employee — excluded even though eligible role.
    { crmId: "9", crmUsername: "Gone.Nine", employmentStatus: "resigned", fullName: "Gone Nine", hireDate: "2024-01-01", hrId: "A-9", jobTitle: "Medical Representative", positionTitle: null },
  ];

  const { matrix } = buildIReports360FieldWorkforceMatrix({
    employees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: [
      visit(1, "2026-05-04", "Rep.One ( Cairo / A )"),
      // Rep One's visit on the 5th where Mgr Seven (crm 7) is the double partner.
      visit(1, "2026-05-05", "Rep.One ( Cairo / A )", 7),
      visit(99, "2026-05-04", "Ghost.Agent ( Unknown / X )"), // orphan visit, no employee → ignored
    ],
  });

  // Header + Rep One (A-1) + Mgr Five (A-5) + Mgr Seven (A-6). Admin Two & Gone Nine excluded.
  const hrIds = matrix.slice(1).map((row) => row[1]);
  assert.deepEqual([...hrIds].sort(), ["A-1", "A-5", "A-6"], "only eligible, active employees appear");

  const repRow = matrix.find((row) => row[1] === "A-1")!;
  const mgrFiveRow = matrix.find((row) => row[1] === "A-5")!;
  const mgrSevenRow = matrix.find((row) => row[1] === "A-6")!;
  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN]; 2026-05-04 = index 8, 05-05 = index 9.
  assert.equal(repRow[8], 1, "Rep One shows 1 regular visit on 2026-05-04");
  // Mgr Five has no visits at all → no numeric activity anywhere.
  assert.ok(
    mgrFiveRow.slice(5).every((cell) => cell === "N" || cell === null),
    "zero-visit manager appears with no numeric activity",
  );
  // Mgr Seven only appears as a double — that joint visit on the 5th must be credited.
  assert.equal(mgrSevenRow[9], 1, "double-partner manager is credited the joint visit on 2026-05-05");
}
