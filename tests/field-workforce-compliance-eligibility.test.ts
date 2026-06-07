import { strict as assert } from "node:assert";

import { isFieldWorkforceComplianceEligibleTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  type IReports360AgentResolver,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";

function visit(agentID: number, visitDate: string, agentName: string | null): IReports360Visit {
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
    doubleID: null,
    doubleName: null,
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

  // --- Matrix builder: only eligible, matched agents become rows ---
  const resolver: IReports360AgentResolver = {
    resolve(agentId) {
      if (agentId === 1) return { eligible: true, fullName: "Rep One", hireDateIso: "2024-01-01", hrId: "A-1" };
      if (agentId === 2) return { eligible: false, fullName: "Admin Two", hireDateIso: "2024-01-01", hrId: "A-2" };
      return null; // agent 3 has no Phoenix HR-ID match
    },
  };

  const { matrix, excludedAgents } = buildIReports360FieldWorkforceMatrix({
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    resolver,
    visits: [
      visit(1, "2026-05-04", "Rep.One ( Cairo / A )"),
      visit(2, "2026-05-04", "Admin.Two ( HQ / Office )"),
      visit(3, "2026-05-04", "Ghost.Agent ( Unknown / X )"),
    ],
  });

  // Header row + exactly one data row (the eligible, matched agent).
  assert.equal(matrix.length, 2, "matrix should contain header + 1 eligible row");
  const dataRow = matrix[1];
  assert.equal(dataRow[0], "Rep One");
  assert.equal(dataRow[1], "A-1"); // HR ID column
  // Ineligible (agent 2) and unmatched (agent 3) are counted, not rendered.
  assert.equal(excludedAgents.ineligibleRole, 1, "one ineligible-role agent excluded");
  assert.equal(excludedAgents.noHrId, 1, "one unmatched (no HR ID) agent excluded");
}
