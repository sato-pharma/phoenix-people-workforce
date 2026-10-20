import assert from "node:assert/strict";

import type { DetectedDvDay } from "../src/lib/probation/intelligence/dv-detection.ts";
import {
  validateDvDay,
  partitionValidatedDvDays,
  type DvValidationContext,
} from "../src/lib/probation/intelligence/dv-validation.ts";

function day(over: Partial<DetectedDvDay> = {}): DetectedDvDay {
  return {
    key: "k",
    employeeHrId: over.employeeHrId ?? "B-178",
    evaluatorHrId: over.evaluatorHrId ?? "A-12",
    dvDate: over.dvDate ?? "2026-06-01",
    visitCount: over.visitCount ?? 5,
    periods: over.periods ?? ["AM"],
    crmVisitIds: over.crmVisitIds ?? [1, 2, 3, 4, 5],
    visits: over.visits ?? [],
  };
}

function ctx(over: Partial<DvValidationContext> = {}): DvValidationContext {
  return {
    caseByEmployee: over.caseByEmployee ??
      new Map([["b-178", { caseId: "case-1", probationStartDate: "2026-04-18", probationEndDate: "2026-07-17", lineName: "Alpha" }]]),
    evaluatorAppRoleByHrId: over.evaluatorAppRoleByHrId ?? new Map([["a-12", "National Sales Manager"]]),
    managerHrIdByEmployee: over.managerHrIdByEmployee ?? new Map([["b-178", "d-1"]]),
    existingDvDayKeys: over.existingDvDayKeys ?? new Set<string>(),
  };
}

export function runProbationDvValidationTests() {
  // Happy path: NSM evaluator, in-window, has a case => validated.
  {
    const v = validateDvDay(day(), ctx());
    assert.equal(v.dvStatus, "validated");
    assert.equal(v.evaluatorRole, "nsm");
    assert.equal(v.caseId, "case-1");
    assert.equal(v.validationReason, null);
  }

  // P3-T04 identity: no probation case => invalid.
  {
    const v = validateDvDay(day({ employeeHrId: "Z-999" }), ctx());
    assert.equal(v.dvStatus, "invalid");
    assert.equal(v.validationReason, "no_probation_case");
  }

  // P3-T05 role: DM is a relationship (evaluator == employee's direct manager).
  {
    const c = ctx({
      evaluatorAppRoleByHrId: new Map(), // no app role
      managerHrIdByEmployee: new Map([["b-178", "A-12"]]), // A-12 manages B-178
    });
    const v = validateDvDay(day({ evaluatorHrId: "A-12" }), c);
    assert.equal(v.evaluatorRole, "dm", "manager of the employee resolves as DM");
    assert.equal(v.dvStatus, "validated");
  }

  // P3-T05 role: TM / PM|GPM mapping.
  assert.equal(validateDvDay(day({ evaluatorHrId: "T-1" }),
    ctx({ evaluatorAppRoleByHrId: new Map([["t-1", "Training Manager"]]) })).evaluatorRole, "tm");
  assert.equal(validateDvDay(day({ evaluatorHrId: "P-1" }),
    ctx({ evaluatorAppRoleByHrId: new Map([["p-1", "Group Product Manager"]]) })).evaluatorRole, "pm_gpm");

  // P3-T05 role: PM/GPM not applicable on CNS line => invalid with specific reason.
  {
    const c = ctx({
      caseByEmployee: new Map([["b-178", { caseId: "c", probationStartDate: "2026-04-18", probationEndDate: "2026-07-17", lineName: "CNS" }]]),
      evaluatorAppRoleByHrId: new Map([["p-1", "Product Manager"]]),
      managerHrIdByEmployee: new Map(),
    });
    const v = validateDvDay(day({ evaluatorHrId: "P-1" }), c);
    assert.equal(v.dvStatus, "invalid");
    assert.equal(v.validationReason, "pm_gpm_not_applicable_cns");
  }

  // P3-T05 role: ineligible role (e.g. a Medical Rep double) => invalid.
  {
    const v = validateDvDay(day({ evaluatorHrId: "MR-1" }),
      ctx({ evaluatorAppRoleByHrId: new Map([["mr-1", "Medical Rep"]]), managerHrIdByEmployee: new Map() }));
    assert.equal(v.dvStatus, "invalid");
    assert.equal(v.validationReason, "evaluator_role_not_eligible");
  }

  // The Regional Sales Manager counts like the National Sales Manager (owner, 2026-10-20).
  {
    const v = validateDvDay(day({ evaluatorHrId: "RSM-1" }),
      ctx({ evaluatorAppRoleByHrId: new Map([["rsm-1", "Regional Manager"]]), managerHrIdByEmployee: new Map() }));
    assert.equal(v.dvStatus, "validated", "a Regional Sales Manager's double visit with a probation rep is an evaluation");
    assert.equal(v.evaluatorRole, "nsm", "and it is counted in the National Sales Manager's bucket");
  }

  // P3-T06 window: DV date before/after the probation window => rejected.
  assert.equal(validateDvDay(day({ dvDate: "2026-04-01" }), ctx()).dvStatus, "rejected");
  assert.equal(validateDvDay(day({ dvDate: "2026-08-01" }), ctx()).dvStatus, "rejected");
  assert.equal(validateDvDay(day({ dvDate: "2026-04-01" }), ctx()).validationReason, "outside_probation_window");
  // Boundaries are inclusive.
  assert.equal(validateDvDay(day({ dvDate: "2026-04-18" }), ctx()).dvStatus, "validated");
  assert.equal(validateDvDay(day({ dvDate: "2026-07-17" }), ctx()).dvStatus, "validated");

  // P3-T03 dedup: an already-captured DV-Day is a no-op (duplicate), checked before other gates.
  {
    const existing = new Set(["a-12|b-178|2026-06-01"]);
    const v = validateDvDay(day(), ctx({ existingDvDayKeys: existing }));
    assert.equal(v.dvStatus, "duplicate");
    assert.equal(v.validationReason, "already_captured");
  }

  // Partition routes statuses correctly.
  {
    const days = [
      validateDvDay(day({ crmVisitIds: [1] }), ctx()),                       // validated
      validateDvDay(day({ employeeHrId: "Z-9" }), ctx()),                    // invalid -> review
      validateDvDay(day({ dvDate: "2026-01-01" }), ctx()),                   // rejected -> review
      validateDvDay(day(), ctx({ existingDvDayKeys: new Set(["a-12|b-178|2026-06-01"]) })), // duplicate
    ];
    const { validated, needsReview, duplicates } = partitionValidatedDvDays(days);
    assert.equal(validated.length, 1);
    assert.equal(needsReview.length, 2, "invalid + rejected go to review");
    assert.equal(duplicates.length, 1);
  }
}
