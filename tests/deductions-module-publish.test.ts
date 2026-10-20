import { strict as assert } from "node:assert";

import { isEligibleForPublish } from "../src/lib/deductions/publish.ts";
import type { DeductionsCandidateWithDecision, DeductionsDecisionStatus } from "../src/lib/deductions/types.ts";

function candidate(
  category: DeductionsCandidateWithDecision["category"],
  decisionStatus: DeductionsDecisionStatus | null,
): DeductionsCandidateWithDecision {
  return {
    id: "c1",
    category,
    sourceSystem: "test",
    sourceRecordId: "rec-1",
    candidateKey: "key-1",
    employeeHrId: "A16",
    employeeHrIdCompact: "a16",
    employeeName: "Test Employee",
    monthKey: "2026-05",
    month: 5,
    year: 2026,
    unit: "days",
    rawValue: 1,
    estimatedAmount: 100,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-05-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-05-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision:
      decisionStatus === null
        ? null
        : {
            id: "d1",
            candidateId: "c1",
            decisionStatus,
            decisionReason: decisionStatus === "Pending" ? "" : "reason",
            hrNote: "",
            appliedValue: null,
            appliedAmount: null,
            appliedDates: null,
            decidedBy: null,
            decidedAt: null,
            actorRoleAtDecision: null,
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-01T00:00:00Z",
          },
  };
}

export async function runDeductionsModulePublishTests(): Promise<void> {
  // 1. Mandatory category (crm): no decision row yet still publishes (defaults to "Pending",
  // and "mandatory unless explicitly cleared" means Pending still counts).
  {
    assert.equal(isEligibleForPublish(candidate("crm", null)), true, "crm with no decision row must still publish (mandatory default)");
    assert.equal(isEligibleForPublish(candidate("crm", "Pending")), true, "crm Pending must still publish");
  }

  // 2. Mandatory category (crm): explicitly cleared is the ONLY thing that excludes it.
  {
    assert.equal(isEligibleForPublish(candidate("crm", "Do Not Take Action")), false, 'crm "Do Not Take Action" must be excluded');
    assert.equal(isEligibleForPublish(candidate("crm", "Approved for Payroll")), true);
    assert.equal(isEligibleForPublish(candidate("crm", "Needs Follow-up")), true, "an open question is not yet a clearance");
    assert.equal(isEligibleForPublish(candidate("crm", "Disputed")), true, "a dispute is not yet a clearance");
  }

  // 3. Every non-mandatory category: ONLY an explicit "Approved for Payroll" publishes.
  {
    const nonMandatory: DeductionsCandidateWithDecision["category"][] = [
      "fingerprint",
      "crm_half_day",
      "no_records_activity",
      "no_weekly_plan",
      "unpaid_vacation",
      "insufficient_balance_vacation",
      "loan",
      "other",
      "field_review",
    ];
    for (const category of nonMandatory) {
      assert.equal(isEligibleForPublish(candidate(category, "Approved for Payroll")), true, `${category}: approved must publish`);
      assert.equal(isEligibleForPublish(candidate(category, null)), false, `${category}: no decision must NOT publish`);
      assert.equal(isEligibleForPublish(candidate(category, "Pending")), false, `${category}: pending must NOT publish`);
      assert.equal(isEligibleForPublish(candidate(category, "Do Not Take Action")), false, `${category}: cleared must NOT publish`);
      assert.equal(isEligibleForPublish(candidate(category, "Needs Follow-up")), false, `${category}: open question must NOT publish`);
      assert.equal(isEligibleForPublish(candidate(category, "Disputed")), false, `${category}: disputed must NOT publish`);
    }
  }
}
