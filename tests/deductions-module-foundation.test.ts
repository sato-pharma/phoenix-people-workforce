import { strict as assert } from "node:assert";

import {
  buildDeductionsCandidateKey,
  compactDeductionsHrId,
  hashStable,
  normalizeDates,
  normalizeMonthKey,
} from "../src/lib/deductions/candidate-key.ts";
import {
  DEDUCTIONS_CATEGORY_CONFIG,
  calculateDeductionAmountFromBaseSalary,
  deductionsCategoryLabel,
  deductionsCategoryRequiresApproval,
  resolveDayBasedDeductionAmount,
  salaryRecordsColumnForCategory,
} from "../src/lib/deductions/calculations.ts";
import {
  DeductionsConflictError,
  detectCandidateConflict,
  detectCrossCategoryConflict,
  findDateOverlap,
} from "../src/lib/deductions/conflict.ts";
import { prepareCandidateInsertPayload, validateCandidateDraft } from "../src/lib/deductions/service.ts";
import { deductionsCategories, type DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

function validDraft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "import-123:rec-1",
    employeeHrId: "A16",
    employeeName: "Test Employee",
    monthKey: "2026-05",
    month: 5,
    year: 2026,
    unit: "days",
    rawValue: 2,
    estimatedAmount: null,
    calculationStatus: "requires_review",
    severity: "Medium",
    reason: "Two days no activity",
    evidence: { source: "field_workforce" },
    dates: ["2026-05-12", "2026-05-13"],
    hierarchySnapshot: { managerHrId: "a01" },
    ...overrides,
  };
}

export async function runDeductionsModuleFoundationTests(): Promise<void> {
  // 1. buildDeductionsCandidateKey determinism
  {
    const baseInput = {
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: "import-123",
      employeeHrId: "A16",
      monthKey: "2026-05",
      category: "crm" as const,
      dates: ["2026-05-12", "2026-05-13"],
    };
    const keys = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      keys.add(buildDeductionsCandidateKey(baseInput));
    }
    assert.equal(keys.size, 1, "candidate key must be deterministic across 10 calls");
  }

  // 2. buildDeductionsCandidateKey sensitivity — changing any input changes the key
  {
    const baseInput = {
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: "import-123",
      employeeHrId: "A16",
      monthKey: "2026-05",
      category: "crm" as const,
      dates: ["2026-05-12", "2026-05-13"],
    };
    const baseKey = buildDeductionsCandidateKey(baseInput);
    const variants = [
      buildDeductionsCandidateKey({ ...baseInput, sourceSystem: "fingerprint_report" }),
      buildDeductionsCandidateKey({ ...baseInput, sourceRecordId: "import-999" }),
      buildDeductionsCandidateKey({ ...baseInput, employeeHrId: "A17" }),
      buildDeductionsCandidateKey({ ...baseInput, monthKey: "2026-06" }),
      buildDeductionsCandidateKey({ ...baseInput, category: "no_records_activity" }),
      buildDeductionsCandidateKey({ ...baseInput, dates: ["2026-05-12"] }),
    ];
    for (const variant of variants) {
      assert.notEqual(variant, baseKey, "changing any input must change the key");
    }
  }

  // 3. candidate key is order-independent on dates (normalizeDates sorts + dedupes)
  {
    const a = buildDeductionsCandidateKey({
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: "x",
      employeeHrId: "A16",
      monthKey: "2026-05",
      category: "crm",
      dates: ["2026-05-13", "2026-05-12", "2026-05-12"],
    });
    const b = buildDeductionsCandidateKey({
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: "x",
      employeeHrId: "A16",
      monthKey: "2026-05",
      category: "crm",
      dates: ["2026-05-12", "2026-05-13"],
    });
    assert.equal(a, b, "dates should be normalized (sorted + deduped) before hashing");
  }

  // 4. normalizeMonthKey — valid + invalid forms
  {
    assert.equal(normalizeMonthKey("2026-5"), "2026-05");
    assert.equal(normalizeMonthKey("2026/05"), "2026-05");
    assert.throws(() => normalizeMonthKey(""), /must not be blank/);
    assert.throws(() => normalizeMonthKey("2026-13"), /out-of-range month/);
    assert.throws(() => normalizeMonthKey("1999-01"), /out-of-range year/);
  }

  // 5. normalizeDates — validates ISO shape, dedupes, sorts
  {
    assert.deepEqual(normalizeDates(["2026-05-13", "2026-05-12", "2026-05-12"]), ["2026-05-12", "2026-05-13"]);
    assert.throws(() => normalizeDates(["2026-13-01"]), /valid calendar date/);
    assert.throws(() => normalizeDates(["not-a-date"]), /YYYY-MM-DD/);
  }

  // 6. hashStable determinism
  {
    assert.equal(hashStable("a|b|c"), hashStable("a|b|c"));
    assert.notEqual(hashStable("a|b|c"), hashStable("a|b|d"));
  }

  // 7. compactDeductionsHrId — lowercases, strips non-alnum, resolves aliases the
  // same way canonicalHrIdKey does (via hr-id.ts) and returns null for blank input
  {
    assert.equal(compactDeductionsHrId("A-16"), "a16");
    assert.equal(compactDeductionsHrId("  a 16 "), "a16");
    assert.equal(compactDeductionsHrId(""), null);
    assert.equal(compactDeductionsHrId(null), null);
  }

  // 8. DEDUCTIONS_CATEGORY_CONFIG — every declared category has a config row,
  // and the taxonomy's one "mandatory unless cleared" rule is exactly CRM
  {
    for (const category of deductionsCategories) {
      assert.ok(DEDUCTIONS_CATEGORY_CONFIG[category], `missing config for category "${category}"`);
      assert.equal(DEDUCTIONS_CATEGORY_CONFIG[category].category, category);
    }
    const mandatory = deductionsCategories.filter((category) => !deductionsCategoryRequiresApproval(category));
    assert.deepEqual(mandatory, ["crm"], "crm must be the only category that does not require approval");
    assert.equal(deductionsCategoryLabel("no_records_activity"), "No Records Activity");
    assert.equal(salaryRecordsColumnForCategory("insufficient_balance_vacation"), "unpaid_vacations");
    assert.equal(salaryRecordsColumnForCategory("fingerprint"), "finger_print");
  }

  // 9. calculateDeductionAmountFromBaseSalary — base ÷ actual calendar days in
  // that month × days, null on invalid input. June 2026 has 30 days, so the
  // baseline cases below are numerically unchanged from the old flat ÷30 rule;
  // the Feb/Jul cases prove the divisor now genuinely tracks the month.
  {
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 3000, deductionDays: 1, month: 6, year: 2026 }), 100);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 13000, deductionDays: 30, month: 6, year: 2026 }), 13000);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 0, deductionDays: 1, month: 6, year: 2026 }), null);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: null, deductionDays: 1, month: 6, year: 2026 }), null);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 3000, deductionDays: -1, month: 6, year: 2026 }), null);
    // February 2026 (not a leap year — 28 days): same 1-day deduction, different divisor.
    assert.equal(
      calculateDeductionAmountFromBaseSalary({ baseSalary: 2800, deductionDays: 1, month: 2, year: 2026 }),
      100,
      "28-day month: 2800 / 28 x 1 = 100",
    );
    // July 2026 (31 days): same shape again, proving the divisor is not hardcoded.
    assert.equal(
      calculateDeductionAmountFromBaseSalary({ baseSalary: 3100, deductionDays: 1, month: 7, year: 2026 }),
      100,
      "31-day month: 3100 / 31 x 1 = 100",
    );
  }

  // 10. resolveDayBasedDeductionAmount — decided amount wins, else estimate from
  // the (possibly HR-edited) day count, else null with nothing to estimate from.
  // All cases anchored to June 2026 (30 days).
  {
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: { appliedAmount: 555 }, rawValue: 2, baseSalary: 3000, month: 6, year: 2026 }),
      555,
      "an explicitly decided amount always wins",
    );
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: { appliedValue: 3 }, rawValue: 2, baseSalary: 3000, month: 6, year: 2026 }),
      300,
      "falls back to base ÷ days-in-month x the HR-edited day count when no amount was decided",
    );
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: null, rawValue: 2, baseSalary: 3000, month: 6, year: 2026 }),
      200,
      "with no decision at all, estimates from the original rawValue (mandatory-category default)",
    );
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: null, rawValue: 2, baseSalary: null, month: 6, year: 2026 }),
      null,
    );
  }

  // 11. detectCandidateConflict — same employee/month/category with overlapping dates
  {
    const a = { employeeHrId: "A16", monthKey: "2026-05", category: "crm" as const, dates: ["2026-05-12", "2026-05-13"] };
    const overlapping = { ...a, dates: ["2026-05-13", "2026-05-14"] };
    const result = detectCandidateConflict(a, overlapping);
    assert.equal(result.conflicts, true);
    assert.deepEqual(result.overlappingDates, ["2026-05-13"]);

    const differentEmployee = { ...overlapping, employeeHrId: "A17" };
    assert.equal(detectCandidateConflict(a, differentEmployee).conflicts, false);

    const differentCategory = { ...overlapping, category: "no_records_activity" as const };
    assert.equal(detectCandidateConflict(a, differentCategory).conflicts, false, "different category is not a same-category conflict");
  }

  // 12. detectCrossCategoryConflict — same employee/day claimed by two DIFFERENT
  // categories (generalizes the legacy MANUAL_HR-vs-FIELD_WORKFORCE mutual-exclusion rule)
  {
    const crmDay = { employeeHrId: "A16", monthKey: "2026-05", category: "crm" as const, dates: ["2026-05-12"] };
    const noRecordsDay = { employeeHrId: "A16", monthKey: "2026-05", category: "no_records_activity" as const, dates: ["2026-05-12"] };
    const result = detectCrossCategoryConflict(crmDay, noRecordsDay);
    assert.equal(result.conflicts, true);
    assert.match(result.reason ?? "", /already tracked by the "crm" pipeline/);

    assert.equal(
      detectCrossCategoryConflict(crmDay, { ...crmDay }).conflicts,
      false,
      "same category is a same-category concern, not a cross-category one",
    );
  }

  // 13. findDateOverlap
  {
    assert.deepEqual(findDateOverlap(["2026-05-12", "2026-05-13"], ["2026-05-13", "2026-05-14"]), ["2026-05-13"]);
    assert.deepEqual(findDateOverlap(["2026-05-12"], ["2026-05-14"]), []);
  }

  // 14. DeductionsConflictError shape
  {
    const error = new DeductionsConflictError(["2026-05-13"]);
    assert.equal(error.code, "DEDUCTIONS_CONFLICT");
    assert.deepEqual(error.overlappingDates, ["2026-05-13"]);
  }

  // 15. validateCandidateDraft — accepts a well-formed draft
  {
    const result = validateCandidateDraft(validDraft());
    assert.equal(result.valid, true, `expected valid, got errors: ${result.errors.join("; ")}`);
  }

  // 16. validateCandidateDraft — rejects bad category/unit/month-year mismatch
  {
    assert.equal(validateCandidateDraft(validDraft({ category: "not_a_category" as never })).valid, false);
    assert.equal(validateCandidateDraft(validDraft({ unit: "hours" as never })).valid, false);
    assert.equal(validateCandidateDraft(validDraft({ month: 6 })).valid, false, "month must match monthKey");
    assert.equal(validateCandidateDraft(validDraft({ rawValue: -1 })).valid, false);
    assert.equal(validateCandidateDraft(validDraft({ dates: [] })).valid, false);
    assert.equal(validateCandidateDraft(validDraft({ employeeHrId: "" })).valid, false);
  }

  // 17. prepareCandidateInsertPayload — derives compact HR id + candidate_key, throws on invalid draft
  {
    const payload = prepareCandidateInsertPayload(validDraft(), { createdBy: "tester" });
    assert.equal(payload.employee_hr_id_compact, "a16");
    assert.equal(payload.category, "crm");
    assert.equal(payload.month_key, "2026-05");
    assert.ok(payload.candidate_key.length > 0);
    assert.throws(() => prepareCandidateInsertPayload(validDraft({ rawValue: -1 }), { createdBy: "tester" }), /Invalid deductions candidate draft/);
    assert.throws(() => prepareCandidateInsertPayload(validDraft(), { createdBy: "" }), /requires options.createdBy/);
  }
}
