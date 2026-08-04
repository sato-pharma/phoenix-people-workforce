// Regression: the By Employee tab summed every candidate that was not explicitly
// cleared, while publishMonth only takes what isEligibleForPublish accepts. On
// production 2026-07 that showed "Ali Mohamed Ali Elsayed" 6,183.86 EGP against a
// real deduction of 0.00 — 54 Pending fingerprint rows worth 23,671.22 EGP were
// counted company-wide and none of them would have been deducted.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { summarizeEmployeeMonthCandidates } from "../src/lib/deductions/service.ts";
import type { DeductionsCandidateWithDecision, DeductionsDecisionStatus } from "../src/lib/deductions/types.ts";

function candidate(input: {
  amount: number;
  category: DeductionsCandidateWithDecision["category"];
  days?: number;
  decisionStatus: DeductionsDecisionStatus | null;
  id: string;
  sourceSystem?: string;
}): DeductionsCandidateWithDecision {
  return {
    id: input.id,
    category: input.category,
    sourceSystem: input.sourceSystem ?? "fingerprint_report",
    sourceRecordId: `rec-${input.id}`,
    candidateKey: `key-${input.id}`,
    employeeHrId: "B-207",
    employeeHrIdCompact: "b207",
    employeeName: "Ali Mohamed Ali Elsayed",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "days",
    rawValue: input.days ?? 1,
    estimatedAmount: input.amount,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-07-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-07-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision:
      input.decisionStatus === null
        ? null
        : {
            id: `d-${input.id}`,
            candidateId: input.id,
            decisionStatus: input.decisionStatus,
            decisionReason: input.decisionStatus === "Pending" ? "" : "reason",
            hrNote: "",
            appliedValue: null,
            appliedAmount: null,
            appliedDates: null,
            decidedBy: null,
            decidedAt: null,
            actorRoleAtDecision: null,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-01T00:00:00Z",
          },
  };
}

export async function runDeductionsEmployeeSummaryPublishEligibilityTests(): Promise<void> {
  // 1. The exact production shape: fingerprint requires an explicit approval, so a
  // Pending row is money publishing will never take.
  const pendingOnly = summarizeEmployeeMonthCandidates({
    candidates: [
      candidate({ amount: 4183.86, category: "fingerprint", days: 4, decisionStatus: "Pending", id: "c1" }),
      candidate({ amount: 2000, category: "fingerprint", days: 2, decisionStatus: null, id: "c2" }),
    ],
    monthKey: "2026-07",
  });
  assert.ok(pendingOnly, "candidates exist, so the employee summary must not be null");
  assert.equal(
    pendingOnly.willPublishTotal,
    0,
    "fingerprint needs an explicit approval — an unapproved row deducts nothing, so the headline figure must be 0",
  );
  assert.equal(
    pendingOnly.pendingTotal,
    6183.86,
    "the 6,183.86 EGP is real detection but unapproved: it belongs in pending, never in the total the employee is told they lose",
  );
  assert.equal(
    pendingOnly.willPublish.fingerprint,
    undefined,
    "no fingerprint row is publishable here, so the category must not appear in the will-publish side at all",
  );
  assert.equal(pendingOnly.pending.fingerprint?.candidateCount, 2, "both unapproved rows must be counted as pending");
  assert.equal(
    pendingOnly.pending.fingerprint?.days,
    6,
    "days follow the same split as money — pending days must not be reported as days that will be deducted",
  );

  // 2. Approval moves the same money across, and nothing is lost in the move.
  const approved = summarizeEmployeeMonthCandidates({
    candidates: [candidate({ amount: 4183.86, category: "fingerprint", days: 4, decisionStatus: "Approved for Payroll", id: "c1" })],
    monthKey: "2026-07",
  });
  assert.equal(approved?.willPublishTotal, 4183.86, "an approved fingerprint row is exactly what Publish commits");
  assert.equal(approved?.pendingTotal, 0, "an approved row is no longer awaiting anything");

  // 3. Do not over-correct: CRM is mandatory-unless-cleared, so a Pending CRM row
  // IS deducted. Treating every Pending row as pending would under-report the
  // employee's real deduction, which is the same defect pointed the other way.
  const mandatory = summarizeEmployeeMonthCandidates({
    candidates: [
      candidate({ amount: 725.81, category: "crm", days: 1, decisionStatus: "Pending", id: "c1", sourceSystem: "crm_visits_mirror" }),
    ],
    monthKey: "2026-07",
  });
  assert.equal(mandatory?.willPublishTotal, 725.81, "a Pending CRM day is deducted by default — it must stay in the headline total");
  assert.equal(mandatory?.pendingTotal, 0, "CRM never waits for an approval, so nothing here is pending");

  // 4. The source-carried exception has to survive too: dsm_no_record sits in the
  // mandatory CRM category on purpose but never auto-publishes.
  const dsm = summarizeEmployeeMonthCandidates({
    candidates: [
      candidate({ amount: 8709.68, category: "crm", days: 12, decisionStatus: "Pending", id: "c1", sourceSystem: "dsm_no_record" }),
    ],
    monthKey: "2026-07",
  });
  assert.equal(dsm?.willPublishTotal, 0, "a district-manager no-record day is never auto-published, whatever its category says");
  assert.equal(dsm?.pendingTotal, 8709.68, "it is detected and must be visible — stated as pending, not as a deduction");

  // 5. A cleared row is neither: it must vanish from both figures rather than
  // reappear as a scary pending number.
  const cleared = summarizeEmployeeMonthCandidates({
    candidates: [candidate({ amount: 1000, category: "fingerprint", days: 1, decisionStatus: "Do Not Take Action", id: "c1" })],
    monthKey: "2026-07",
  });
  assert.equal(cleared?.willPublishTotal, 0, "a cleared row is not deducted");
  assert.equal(cleared?.pendingTotal, 0, "a cleared row is decided, so it is not awaiting a decision either");

  // 6. Mixed month: the two figures must partition the not-cleared money exactly —
  // no candidate may be dropped by the split, and none may be counted twice.
  const mixed = summarizeEmployeeMonthCandidates({
    candidates: [
      candidate({ amount: 4183.86, category: "fingerprint", days: 4, decisionStatus: "Pending", id: "c1" }),
      candidate({ amount: 2000, category: "fingerprint", days: 2, decisionStatus: "Approved for Payroll", id: "c2" }),
      candidate({ amount: 725.81, category: "crm", days: 1, decisionStatus: "Pending", id: "c3", sourceSystem: "crm_visits_mirror" }),
      candidate({ amount: 1000, category: "unpaid_vacation", days: 1, decisionStatus: "Do Not Take Action", id: "c4", sourceSystem: "vacation_balance" }),
    ],
    monthKey: "2026-07",
  });
  assert.equal(mixed?.willPublishTotal, 2725.81, "only the approved fingerprint row and the mandatory CRM day are deducted");
  assert.equal(mixed?.pendingTotal, 4183.86, "the unapproved fingerprint row is the whole gap");
  assert.equal(
    Math.round(((mixed?.willPublishTotal ?? 0) + (mixed?.pendingTotal ?? 0)) * 100) / 100,
    6909.67,
    "will-publish plus pending must equal every non-cleared candidate — a split that loses money is worse than the bug",
  );
  assert.equal(mixed?.willPublish.unpaid_vacation, undefined, "the cleared category must appear on neither side");
  assert.equal(mixed?.pending.unpaid_vacation, undefined, "the cleared category must appear on neither side");

  // 7. Nothing detected is still nothing to show.
  assert.equal(
    summarizeEmployeeMonthCandidates({ candidates: [], monthKey: "2026-07" }),
    null,
    "an employee with no candidates has no summary — the tab shows its own empty state instead of a 0 EGP card",
  );

  // 8. The screen must actually surface the gap. A correct service that the UI
  // re-adds into one number reintroduces the exact defect.
  const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
  assert.match(
    workspace,
    /summary\.pendingTotal/,
    "the By Employee card must render the pending figure separately, the same way the Overview tab does",
  );
  assert.match(
    workspace,
    /summary\.willPublishTotal/,
    "the By Employee headline must be the will-publish figure, so both tabs quote the same number for the same person",
  );
}
