import { strict as assert } from "node:assert";

import { mapPublicationLine, mergePortalLines } from "../src/lib/deductions/portal.ts";
import type { DeductionMonthlySummaryLine } from "../src/lib/deductions-governance/types.ts";
import { deductionsCategories, type DeductionsCategory } from "../src/lib/deductions/types.ts";

function publicationLineRow(overrides: Partial<Parameters<typeof mapPublicationLine>[0]> = {}) {
  return {
    id: "line-1",
    publication_id: "pub-1",
    candidate_id: "cand-1",
    decision_id: "dec-1",
    employee_hr_id: "B-124",
    employee_hr_id_compact: "b124",
    employee_name: "Test Employee",
    month_key: "2026-06",
    category: "crm" as DeductionsCategory,
    unit: "days",
    original_value: 2,
    applied_value: 2,
    applied_amount: 933.34,
    dates: ["2026-06-11", "2026-06-22"],
    reason: "Field Workforce Compliance no-activity candidate",
    hr_note: null,
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function legacyLine(overrides: Partial<DeductionMonthlySummaryLine> = {}): DeductionMonthlySummaryLine {
  return {
    id: "legacy-line-1",
    summaryId: "summary-1",
    candidateId: "legacy-cand-1",
    decisionId: "legacy-dec-1",
    employeeCode: "B-1",
    employeeHrIdCompact: "b1",
    employeeName: "Legacy Employee",
    monthKey: "2026-05",
    sourceModule: "FIELD_WORKFORCE",
    deductionType: "no_activity",
    payrollColumn: "crm",
    deductionUnit: "days",
    originalDeductionValue: 1,
    appliedDeductionValue: 1,
    appliedAmount: 466.67,
    dates: ["2026-05-10"],
    reason: null,
    hrNote: null,
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

export async function runDeductionsModulePortalTests(): Promise<void> {
  // 1. mapPublicationLine — every one of the 7 categories maps to a distinct,
  // valid payrollColumn (widened DeductionPayrollColumn), never falls through
  // to the "else -> Unpaid Vacations" trap the legacy 3-value enum would hit.
  {
    const expectedColumns: Record<DeductionsCategory, string> = {
      fingerprint: "finger_print",
      crm: "crm",
      no_records_activity: "other_deductions",
      unpaid_vacation: "unpaid_vacations",
      insufficient_balance_vacation: "unpaid_vacations",
      loan: "loans",
      other: "other_deductions",
    };
    for (const category of deductionsCategories) {
      const mapped = mapPublicationLine(publicationLineRow({ category }));
      assert.equal(mapped.payrollColumn, expectedColumns[category], `${category} -> payrollColumn`);
      assert.equal(mapped.deductionType, category, `${category} -> deductionType passthrough`);
      assert.equal(mapped.sourceModule, "DEDUCTIONS_MODULE");
    }
  }

  // 2. mapPublicationLine — decisionId null-coalesces to "" (legacy shape is
  // non-nullable), never throws or produces "null" as a string.
  {
    const mapped = mapPublicationLine(publicationLineRow({ decision_id: null }));
    assert.equal(mapped.decisionId, "");
  }

  // 3. mapPublicationLine — unit "amount" maps through; anything else
  // defaults to "days" (the only two units the new module's schema allows).
  {
    assert.equal(mapPublicationLine(publicationLineRow({ unit: "amount" })).deductionUnit, "amount");
    assert.equal(mapPublicationLine(publicationLineRow({ unit: "days" })).deductionUnit, "days");
  }

  // 4. mapPublicationLine — non-array dates (defensive; jsonb column is typed
  // unknown) never throws, degrades to an empty array.
  {
    const mapped = mapPublicationLine(publicationLineRow({ dates: null }));
    assert.deepEqual(mapped.dates, []);
  }

  // 5. mergePortalLines — a month the new module has published excludes that
  // month's legacy rows entirely (cutover replaces, never supplements).
  {
    const newLine = mapPublicationLine(publicationLineRow({ month_key: "2026-06" }));
    const staleLegacyLine = legacyLine({ monthKey: "2026-06", employeeName: "Should Be Excluded" });
    const olderLegacyLine = legacyLine({ monthKey: "2026-05", employeeName: "Should Survive" });
    const merged = mergePortalLines([newLine], [staleLegacyLine, olderLegacyLine], new Set(["2026-06"]));
    assert.equal(merged.length, 2);
    assert.ok(merged.some((l) => l.candidateId === newLine.candidateId), "new-module line survives");
    assert.ok(merged.some((l) => l.employeeName === "Should Survive"), "uncovered older month's legacy line survives");
    assert.ok(!merged.some((l) => l.employeeName === "Should Be Excluded"), "covered month's legacy line is excluded");
  }

  // 6. mergePortalLines — no new-module publications at all (coveredMonthKeys
  // empty) is a no-op passthrough of every legacy line, pre-cutover behavior
  // preserved exactly.
  {
    const legacyOnly = [legacyLine({ monthKey: "2026-04" }), legacyLine({ monthKey: "2026-03", employeeName: "A" })];
    const merged = mergePortalLines([], legacyOnly, new Set());
    assert.equal(merged.length, 2);
  }

  // 7. mergePortalLines — sort order matches the legacy query: month_key
  // descending, then employee_name ascending within a month.
  {
    const a = legacyLine({ monthKey: "2026-06", employeeName: "Zara" });
    const b = legacyLine({ monthKey: "2026-06", employeeName: "Amir" });
    const c = legacyLine({ monthKey: "2026-05", employeeName: "Omar" });
    const merged = mergePortalLines([], [a, b, c], new Set());
    assert.deepEqual(
      merged.map((l) => l.employeeName),
      ["Amir", "Zara", "Omar"],
    );
  }
}
