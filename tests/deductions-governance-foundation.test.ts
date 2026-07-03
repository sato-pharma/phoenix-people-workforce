import { strict as assert } from "node:assert";

import {
  buildDeductionCandidateKey,
  hashStable,
  normalizeDates,
  normalizeMonthKey,
} from "../src/lib/deductions-governance/candidate-key.ts";
import {
  DeductionConflictError,
  detectCandidateConflict,
  findDateOverlap,
} from "../src/lib/deductions-governance/conflict.ts";
import {
  prepareCandidateInsertPayload,
  validateCandidateDraft,
} from "../src/lib/deductions-governance/service.ts";
import * as Svc from "../src/lib/deductions-governance/service.ts";
import {
  deductionDecisionReasons,
  deductionDecisionStatuses,
  type DeductionCandidateDraft,
} from "../src/lib/deductions-governance/types.ts";

function validDraft(): DeductionCandidateDraft {
  return {
    sourceModule: "FIELD_WORKFORCE",
    sourceRecordId: "import-123",
    employeeCode: "A16",
    employeeName: "Test Employee",
    monthKey: "2026-05",
    month: 5,
    year: 2026,
    deductionType: "no_activity",
    deductionUnit: "days",
    deductionValue: 2,
    estimatedAmount: null,
    calculationStatus: "requires_payroll_review",
    severity: "Medium",
    reason: "Two days no activity",
    evidence: { source: "field_workforce" },
    holidayContext: null,
    dates: ["2026-05-12", "2026-05-13"],
    hierarchySnapshot: { managerHrId: "a01" },
  };
}

export async function runDeductionsGovernanceFoundationTests(): Promise<void> {
  // 1. buildDeductionCandidateKey determinism
  {
    const baseInput = {
      sourceModule: "FIELD_WORKFORCE",
      sourceRecordId: "import-123",
      employeeCode: "A16",
      monthKey: "2026-05",
      deductionType: "no_activity" as const,
      dates: ["2026-05-12", "2026-05-13"],
    };
    const keys = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      keys.add(buildDeductionCandidateKey(baseInput));
    }
    assert.equal(keys.size, 1, "candidate key must be deterministic across 10 calls");
  }

  // 2. buildDeductionCandidateKey sensitivity
  {
    const baseInput = {
      sourceModule: "FIELD_WORKFORCE",
      sourceRecordId: "import-123",
      employeeCode: "A16",
      monthKey: "2026-05",
      deductionType: "no_activity" as const,
      dates: ["2026-05-12", "2026-05-13"],
    };
    const baseKey = buildDeductionCandidateKey(baseInput);
    const variants = [
      buildDeductionCandidateKey({ ...baseInput, sourceModule: "ATTENDANCE_DEVICE" }),
      buildDeductionCandidateKey({ ...baseInput, sourceRecordId: "import-999" }),
      buildDeductionCandidateKey({ ...baseInput, employeeCode: "A17" }),
      buildDeductionCandidateKey({ ...baseInput, monthKey: "2026-06" }),
      buildDeductionCandidateKey({ ...baseInput, deductionType: "absence" }),
      buildDeductionCandidateKey({ ...baseInput, dates: ["2026-05-12"] }),
    ];
    for (const variant of variants) {
      assert.notEqual(variant, baseKey, "changing any input must change the key");
    }
  }

  // 3. normalizeMonthKey
  {
    for (const input of ["2026-05", "2026-5", "2026/05", "2026/5"]) {
      assert.equal(normalizeMonthKey(input), "2026-05", `monthKey ${input} must normalize to 2026-05`);
    }
    for (const bad of ["", "May 2026", "20260530", "99-13"]) {
      assert.throws(
        () => normalizeMonthKey(bad),
        Error,
        `normalizeMonthKey should throw on "${bad}"`,
      );
    }
  }

  // 4. normalizeDates: sorts, dedupes, throws on invalid
  {
    const sorted = normalizeDates(["2026-05-13", "2026-05-12", "2026-05-12"]);
    assert.deepEqual(sorted, ["2026-05-12", "2026-05-13"]);
    assert.throws(() => normalizeDates(["not-a-date"]), Error);
    assert.throws(() => normalizeDates(["2026-13-01"]), Error);
  }

  // 5. validateCandidateDraft
  {
    assert.equal(validateCandidateDraft(validDraft()).valid, true, "fully populated draft must validate");

    {
      const draft = validDraft() as Partial<DeductionCandidateDraft>;
      delete draft.employeeCode;
      const result = validateCandidateDraft(draft as DeductionCandidateDraft);
      assert.equal(result.valid, false, "missing employeeCode should fail");
      assert.ok(result.errors.some((message) => message.includes("employeeCode")));
    }

    {
      const draft = validDraft();
      draft.deductionType = "not-a-type" as unknown as DeductionCandidateDraft["deductionType"];
      const result = validateCandidateDraft(draft);
      assert.equal(result.valid, false, "bad deductionType should fail");
      assert.ok(result.errors.some((message) => message.includes("deductionType")));
    }

    {
      const draft = validDraft();
      draft.deductionValue = -1;
      const result = validateCandidateDraft(draft);
      assert.equal(result.valid, false, "negative deductionValue should fail");
      assert.ok(result.errors.some((message) => message.includes("deductionValue")));
    }

    {
      const draft = validDraft();
      draft.month = 6; // monthKey is 2026-05 so this mismatches
      const result = validateCandidateDraft(draft);
      assert.equal(result.valid, false, "month/monthKey mismatch should fail");
      assert.ok(result.errors.some((message) => message.includes("month")));
    }
  }

  // 6. prepareCandidateInsertPayload
  {
    const draft = validDraft();
    const payload = prepareCandidateInsertPayload(draft, { createdBy: "hr-tester" });
    const expectedKey = buildDeductionCandidateKey({
      sourceModule: draft.sourceModule,
      sourceRecordId: draft.sourceRecordId,
      employeeCode: draft.employeeCode,
      monthKey: draft.monthKey,
      deductionType: draft.deductionType,
      dates: draft.dates,
    });
    assert.equal(payload.candidate_key, expectedKey, "payload candidate_key must match buildDeductionCandidateKey output");
    assert.equal(payload.created_by, "hr-tester");
    assert.equal(payload.month_key, "2026-05");
    assert.deepEqual(payload.dates, ["2026-05-12", "2026-05-13"]);

    const invalidDraft = validDraft();
    invalidDraft.deductionValue = -5;
    assert.throws(
      () => prepareCandidateInsertPayload(invalidDraft, { createdBy: "hr-tester" }),
      /Invalid deduction candidate draft/,
    );
  }

  // 7. findDateOverlap
  {
    assert.deepEqual(findDateOverlap([], ["2026-05-01"]), []);
    assert.deepEqual(
      findDateOverlap(["2026-05-01", "2026-05-02", "2026-05-03"], ["2026-05-02", "2026-05-04"]),
      ["2026-05-02"],
    );
    assert.deepEqual(
      findDateOverlap(["2026-05-03", "2026-05-01", "2026-05-02", "2026-05-01"], ["2026-05-02", "2026-05-01", "2026-05-03"]),
      ["2026-05-01", "2026-05-02", "2026-05-03"],
    );
  }

  // 8. detectCandidateConflict
  {
    const base = {
      employeeCode: "A16",
      monthKey: "2026-05",
      deductionType: "no_activity" as const,
      dates: ["2026-05-12", "2026-05-13"],
    };
    const conflict = detectCandidateConflict(base, {
      ...base,
      dates: ["2026-05-13", "2026-05-14"],
    });
    assert.equal(conflict.conflicts, true);
    assert.deepEqual(conflict.overlappingDates, ["2026-05-13"]);

    const differentEmployee = detectCandidateConflict(base, { ...base, employeeCode: "A17" });
    assert.equal(differentEmployee.conflicts, false);

    const differentType = detectCandidateConflict(base, { ...base, deductionType: "absence" });
    assert.equal(differentType.conflicts, false);

    const noDateOverlap = detectCandidateConflict(base, {
      ...base,
      dates: ["2026-05-20", "2026-05-21"],
    });
    assert.equal(noDateOverlap.conflicts, false);

    // Sanity: DeductionConflictError has expected code and payload
    const err = new DeductionConflictError(["2026-05-13"]);
    assert.equal(err.code, "DEDUCTION_CONFLICT");
    assert.deepEqual(err.overlappingDates, ["2026-05-13"]);
  }

  // 9. Service module surface must NOT expose payroll/leave mutation functions
  {
    const dangerousPattern = /(mutate|pushToPayroll|writeLeave|updateSalary|execute)/i;
    for (const name of Object.keys(Svc)) {
      const value = (Svc as Record<string, unknown>)[name];
      if (typeof value === "function" && dangerousPattern.test(name)) {
        throw new Error(`Service module exports a forbidden function "${name}"`);
      }
    }
  }

  // 10. Type tuple exhaustiveness
  {
    assert.equal(deductionDecisionStatuses.length, 8, "expected 8 decision statuses");
    const requiredStatuses = [
      "Pending",
      "Approved for Payroll",
      "Approved for Leave Adjustment",
      "Do Not Take Action",
      "Needs Follow-up",
      "Disputed",
      "Resolved",
      "Cancelled",
    ];
    for (const status of requiredStatuses) {
      assert.ok(
        (deductionDecisionStatuses as readonly string[]).includes(status),
        `decision status "${status}" must be present`,
      );
    }
    // 17 = original 14 + 3 attendance-settlement system reasons ("Employee
    // confirmed", "Employee did not respond (auto-confirmed)", "Dispute
    // reviewed and rejected") added for recordSystemApprovedAttendanceDecision.
    assert.equal(deductionDecisionReasons.length, 17, "expected 17 decision reasons");
  }

  // Sanity: hashStable is stable and hex
  {
    const a = hashStable("abc");
    const b = hashStable("abc");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  }
}
