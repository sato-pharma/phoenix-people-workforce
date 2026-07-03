import { strict as assert } from "node:assert";

import { isFieldWorkforceComplianceEligibleTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  visitFromMirrorRow,
  type FieldWorkforceEmployeeInput,
  type VisitsMirrorRow,
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

  // --- Mirror-row parity: visitFromMirrorRow -> buildIReports360FieldWorkforceMatrix must
  // produce IDENTICAL classification to feeding the equivalent IReports360Visit objects
  // directly, since FWC now sources its matrix from the ireports360_visits mirror table
  // instead of a live CRM call. Covers VISIT_TYPE_TO_STATUS mapping (regular/AV/CP),
  // Friday-blank, and the double-visit credit path — all through the mirror-row shape. ---
  const mirrorRows: VisitsMirrorRow[] = [
    // Regular visit -> numeric count.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-04", visit_type: 0 },
    // Same day, second regular visit -> count of 2.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-04", visit_type: 0 },
    // Annual Vacation -> "AV".
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-11", visit_type: -4 },
    // Campaign -> "CP", and credited to the double partner (Mgr Seven, crm 7) too.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: 7, double_name: "Mgr.Seven ( HQ / B )", visit_date: "2026-05-18", visit_type: -8 },
  ];
  const mirrorEmployees: FieldWorkforceEmployeeInput[] = [
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
  ];

  const { matrix: mirrorMatrix } = buildIReports360FieldWorkforceMatrix({
    employees: mirrorEmployees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: mirrorRows.map(visitFromMirrorRow),
  });
  const directVisits: IReports360Visit[] = mirrorRows.map((row) => ({
    agentID: row.agent_crm_id,
    agentName: row.agent_name,
    ampm: null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    customerName: null,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: 0,
    saveDate: null,
    visitDate: row.visit_date,
    visitType: row.visit_type as number,
    visitTypeDescription: null,
  }));
  const { matrix: directMatrix } = buildIReports360FieldWorkforceMatrix({
    employees: mirrorEmployees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: directVisits,
  });
  assert.deepEqual(mirrorMatrix, directMatrix, "mirror-row mapping must produce an identical matrix to the direct IReports360Visit shape");

  const mirrorRepRow = mirrorMatrix.find((row) => row[1] === "A-1")!;
  const mirrorMgrRow = mirrorMatrix.find((row) => row[1] === "A-6")!;
  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN]; 05-04=idx8, 05-11=idx15, 05-18=idx22.
  assert.equal(mirrorRepRow[8], 2, "two regular visits on the same day sum to a count of 2");
  assert.equal(mirrorRepRow[15], "AV", "visitType -4 maps to AV via the mirror row path");
  assert.equal(mirrorRepRow[22], "CP", "visitType -8 maps to CP via the mirror row path");
  assert.equal(mirrorMgrRow[22], "CP", "the double partner is credited the same CP day via the mirror row path");
}
