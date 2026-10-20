import { strict as assert } from "node:assert";

import { mapPublicationLine, sortPortalLines } from "../src/lib/deductions/portal.ts";
import {
  deductionsCategories,
  type DeductionsCategory,
  type DeductionsPortalLine,
} from "../src/lib/deductions/types.ts";

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

function portalLine(overrides: Partial<DeductionsPortalLine> = {}): DeductionsPortalLine {
  return {
    id: "line-1",
    summaryId: "pub-1",
    candidateId: "cand-1",
    decisionId: "dec-1",
    employeeCode: "B-1",
    employeeHrIdCompact: "b1",
    employeeName: "Test Employee",
    monthKey: "2026-05",
    sourceModule: "DEDUCTIONS_MODULE",
    deductionType: "crm",
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
  // 1. mapPublicationLine — every one of the 9 categories maps to a distinct,
  // valid payrollColumn (widened DeductionsSalaryRecordsColumn), never falls
  // through to the "else -> Unpaid Vacations" trap the legacy 3-value enum would hit.
  {
    const expectedColumns: Record<DeductionsCategory, string> = {
      fingerprint: "finger_print",
      crm: "crm",
      crm_half_day: "crm",
      no_records_activity: "other_deductions",
      // Daily-module only (owner, 2026-10-12) — it writes no candidate here, but its column is
      // Other, so a line that ever did reach payroll must not fall through to Unpaid Vacations.
      no_weekly_plan: "other_deductions",
      unpaid_vacation: "unpaid_vacations",
      insufficient_balance_vacation: "unpaid_vacations",
      loan: "loans",
      other: "other_deductions",
      // A field day reviewed in the HR operations report pays through the CRM column (owner, 2026-10-20).
      field_review: "crm",
    };
    for (const category of deductionsCategories) {
      const mapped = mapPublicationLine(publicationLineRow({ category }));
      assert.equal(mapped.payrollColumn, expectedColumns[category], `${category} -> payrollColumn`);
      assert.equal(mapped.deductionType, category, `${category} -> deductionType passthrough`);
      assert.equal(mapped.sourceModule, "DEDUCTIONS_MODULE");
    }
  }

  // 2. mapPublicationLine — decisionId null-coalesces to "" (portal shape is
  // non-nullable), never throws or produces "null" as a string.
  {
    const mapped = mapPublicationLine(publicationLineRow({ decision_id: null }));
    assert.equal(mapped.decisionId, "");
  }

  // 3. mapPublicationLine — unit "amount" maps through; anything else
  // defaults to "days" (the only two units the module's schema allows).
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

  // 5. sortPortalLines — as of the C6 cutover the portal reads a single source
  // (this module's publications), so sorting is a pure ordering of that one list:
  // month_key descending, then employee_name ascending within a month.
  {
    const a = portalLine({ id: "a", monthKey: "2026-06", employeeName: "Zara" });
    const b = portalLine({ id: "b", monthKey: "2026-06", employeeName: "Amir" });
    const c = portalLine({ id: "c", monthKey: "2026-05", employeeName: "Omar" });
    const sorted = sortPortalLines([a, b, c]);
    assert.deepEqual(
      sorted.map((l) => l.employeeName),
      ["Amir", "Zara", "Omar"],
    );
  }

  // 6. sortPortalLines — a pure function: it never mutates its input and an empty
  // list is a no-op passthrough.
  {
    const input = [portalLine({ id: "x", monthKey: "2026-04" }), portalLine({ id: "y", monthKey: "2026-06" })];
    const originalOrder = input.map((l) => l.id);
    const sorted = sortPortalLines(input);
    assert.deepEqual(sorted.map((l) => l.id), ["y", "x"], "newest month first");
    assert.deepEqual(input.map((l) => l.id), originalOrder, "input array is not mutated");
    assert.deepEqual(sortPortalLines([]), [], "empty list stays empty");
  }
}
