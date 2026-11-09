import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { hireDateMovedLater, planPreHireRetirement } from "../src/lib/deductions/pre-hire.ts";
import type { DeductionsCandidate } from "../src/lib/deductions/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// Owner, 2026-11-09: "stop hire-date edits from leaving pre-hire deductions behind". A rep's
// August unpaid-vacation lines were collected on 8 October; his hire date was set to 1 October on the
// 12th, and six lines for days before he joined stayed Pending.

function row(overrides: Partial<DeductionsCandidate>): DeductionsCandidate {
  return {
    id: "id",
    category: "unpaid_vacation",
    sourceSystem: "crm_vacation_signal",
    sourceRecordId: "record",
    candidateKey: "key",
    employeeHrId: "TEST-0001",
    employeeHrIdCompact: "test0001",
    employeeName: "Test Rep",
    monthKey: "2026-08",
    month: 8,
    year: 2026,
    unit: "days",
    rawValue: 1,
    estimatedAmount: 500,
    calculationStatus: "calculated",
    severity: "High",
    reason: null,
    evidence: {},
    dates: ["2026-08-03"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-10-08T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    ...overrides,
  };
}

export async function runDeductionsPreHireTests(): Promise<void> {
  // ── Only a hire date moved LATER (or set for the first time) can strand a line ───────────────
  {
    assert.equal(hireDateMovedLater("2026-08-01", "2026-10-01"), true, "a later hire date strands the days between");
    assert.equal(hireDateMovedLater(null, "2026-10-01"), true, "a first hire date can strand earlier lines");
    assert.equal(hireDateMovedLater("2026-10-01", "2026-10-01"), false, "an unchanged hire date does nothing");
    assert.equal(hireDateMovedLater("2026-10-01", "2026-08-01"), false, "an earlier hire date strands nothing");
    assert.equal(hireDateMovedLater("2026-10-01", null), false, "a cleared hire date does nothing");
  }

  // ── Every line wholly before the hire date is retired; a later one is left alone ─────────────
  {
    const plan = planPreHireRetirement({
      hireDate: "2026-10-01",
      rows: [
        row({ id: "aug-03", dates: ["2026-08-03"] }),
        row({ id: "aug-04", dates: ["2026-08-04"] }),
        row({ id: "oct-05", monthKey: "2026-10", month: 10, dates: ["2026-10-05"] }),
      ],
    });
    assert.equal(plan.groups.length, 1, "only August holds a pre-hire day");
    const [august] = plan.groups;
    assert.deepEqual(august!.candidateIds.sort(), ["aug-03", "aug-04"], "both August lines are named for retirement");
    assert.equal(august!.retired, 2);
    assert.deepEqual(august!.drafts, [], "a line wholly before the hire date gets no replacement");
  }

  // ── A CRM line that straddles the hire date keeps only the days from it on ───────────────────
  {
    const plan = planPreHireRetirement({
      hireDate: "2026-10-28",
      rows: [
        row({
          id: "crm",
          category: "crm",
          sourceSystem: "crm_visits_mirror",
          monthKey: "2026-10",
          month: 10,
          rawValue: 4,
          estimatedAmount: 2000,
          dates: ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"],
        }),
      ],
    });
    const [group] = plan.groups;
    assert.equal(group!.narrowed, 1);
    assert.deepEqual(group!.candidateIds, ["crm"]);
    assert.deepEqual(group!.drafts[0]!.dates, ["2026-10-28"], "only the hire day survives");
    assert.equal(group!.drafts[0]!.rawValue, 1);
    assert.ok(
      (group!.drafts[0]!.estimatedAmount ?? 0) > 0 && (group!.drafts[0]!.estimatedAmount ?? 0) < 2000,
      "the replacement is priced on the kept day, not the whole line",
    );
  }

  // ── Never touched: a locked line, a manual entry, an amount line, an inexact multi-day line ──
  {
    const plan = planPreHireRetirement({
      hireDate: "2026-10-01",
      rows: [
        row({ id: "locked", lockedAt: "2026-09-01T00:00:00Z" }),
        row({ id: "loan", category: "loan", sourceSystem: "manual_hr", unit: "amount", dates: ["2026-08-01"] }),
        row({ id: "other", category: "other", sourceSystem: "manual_hr", dates: ["2026-08-01"] }),
        row({ id: "vacation", rawValue: 3, dates: ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"] }),
      ],
    });
    assert.equal(plan.groups.length, 0, "nothing here may be retired or narrowed");
    assert.deepEqual(
      plan.notNarrowable.map((line) => line.id),
      ["vacation"],
      "a line charging working days over calendar dates is reported, not guessed at",
    );
  }

  // ── Reconcile retires ONLY the named lines, and an empty set is deliberate there ─────────────
  {
    const service = stripComments(readFileSync("src/lib/deductions/service.ts", "utf8"));
    assert.ok(
      service.includes("!input.scope.onlyCandidateIds || input.scope.onlyCandidateIds.has(candidate.id)"),
      "reconcile must narrow its retirement to onlyCandidateIds when given",
    );
    assert.ok(
      service.includes("input.drafts.length === 0 && scoped.length > 0 && !input.scope.onlyCandidateIds"),
      "the empty-set guard must stand down only for a caller that named its lines",
    );
  }

  // ── Every save path that writes a hire date re-states the pre-hire lines ─────────────────────
  for (const path of [
    "src/lib/employees/employee-directory.ts",
    "src/lib/hiring-pack/service.ts",
    "app/api/imports/employees/confirm/route.ts",
  ]) {
    const source = stripComments(readFileSync(path, "utf8"));
    assert.ok(
      source.includes("await restatePreHireDeductionsAfterHireDateSave({"),
      `${path} writes a hire date and must re-state the lines before it`,
    );
  }
}
