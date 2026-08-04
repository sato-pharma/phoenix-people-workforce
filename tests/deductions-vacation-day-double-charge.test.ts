// One employee-day of unpaid vacation must be chargeable exactly once, whichever
// source found it.
//
// Unpaid Vacation has two detectors: the HR request (`vacation_balance`) and a
// CRM annual-leave record (`crm_vacation_signal`). They emit under ONE category,
// so the (category, candidate_key) unique index never fires — only the source
// prefix inside the key differs — and the day-collision gate, which compared
// categories, could not see it either. Measured on July 2026 production: 19
// employee-days, 8,822.54 EGP, would have been charged twice on the next
// collection run.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { findDayCollisions } from "../src/lib/deductions/conflict.ts";
import { mergeVacationSourcesHrRequestWins } from "../src/lib/deductions/connectors/vacation.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "unpaid_vacation",
    sourceSystem: "vacation_balance",
    sourceRecordId: "vacation:req-1:unpaid_vacation",
    employeeHrId: "B-124",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "days",
    rawValue: 1,
    dates: ["2026-07-06"],
    ...overrides,
  };
}

export async function runDeductionsVacationDayDoubleChargeTests(): Promise<void> {
  // ── The HR request owns the day; the CRM record for it is dropped ─────────
  {
    const fromRequests = [
      draft({ dates: ["2026-07-06", "2026-07-07", "2026-07-08"], rawValue: 3 }),
    ];
    const fromCrm = [
      draft({
        dates: ["2026-07-07"],
        sourceRecordId: "crm-vacation:B-124:2026-07-07:unpaid_vacation",
        sourceSystem: "crm_vacation_signal",
      }),
    ];

    const merged = mergeVacationSourcesHrRequestWins({ fromCrm, fromRequests });
    assert.equal(
      merged.length,
      1,
      "a CRM vacation day inside an approved HR request must not survive as a second candidate — both would charge 2026-07-07",
    );
    assert.equal(
      merged[0].sourceSystem,
      "vacation_balance",
      "the HR request is the human-filed record and must be the survivor, not the CRM detection of it",
    );
  }

  // ── A CRM day the HR request does NOT cover is still charged ──────────────
  // The CRM source exists because leave taken only on CRM was previously found
  // by nothing at all; de-duplicating must not quietly restore that blind spot.
  {
    const fromRequests = [draft({ dates: ["2026-07-06"] })];
    const fromCrm = [
      draft({
        dates: ["2026-07-20"],
        sourceRecordId: "crm-vacation:B-124:2026-07-20:unpaid_vacation",
        sourceSystem: "crm_vacation_signal",
      }),
    ];

    const merged = mergeVacationSourcesHrRequestWins({ fromCrm, fromRequests });
    assert.equal(merged.length, 2, "a CRM vacation day no HR request covers is a real absence and must still be charged");
  }

  // ── The two sources are matched on the canonical HR_ID ────────────────────
  // employees.hr_id and v2_vacation_requests.employee_hr_id are different
  // tables; a case difference between them must not read as a different person,
  // because a missed match here is a day charged twice.
  {
    const merged = mergeVacationSourcesHrRequestWins({
      fromCrm: [
        draft({
          employeeHrId: "b-124",
          sourceRecordId: "crm-vacation:b-124:2026-07-06:unpaid_vacation",
          sourceSystem: "crm_vacation_signal",
        }),
      ],
      fromRequests: [draft({ employeeHrId: "B-124" })],
    });
    assert.equal(merged.length, 1, "B-124 and b-124 are the same employee, so the same day is claimed once");
  }

  // ── One category, two sources, one day → a collision ──────────────────────
  {
    const collisions = findDayCollisions([
      {
        category: "unpaid_vacation",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        employeeName: "Test Employee",
        sourceSystem: "vacation_balance",
      },
      {
        category: "unpaid_vacation",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        employeeName: "Test Employee",
        sourceSystem: "crm_vacation_signal",
      },
    ]);
    assert.equal(
      collisions.length,
      1,
      "two sources charging one day is a double deduction whether or not they share a category",
    );
    assert.deepEqual(
      collisions[0].sourceSystems,
      ["crm_vacation_signal", "vacation_balance"],
      "the gate must name both sources — with one category to show, the source is all that tells the reviewer which row to clear",
    );
  }

  // ── Same category AND same source on one day → not a collision ────────────
  {
    const collisions = findDayCollisions([
      {
        category: "unpaid_vacation",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "vacation_balance",
      },
      {
        category: "unpaid_vacation",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "vacation_balance",
      },
    ]);
    assert.deepEqual(
      collisions,
      [],
      "one source emitting the same day twice is a defect in that source, not a double deduction to block the month over",
    );
  }

  // ── A manual entry's anchor date never collides with a real detected day ──
  // connectors/manual.ts anchors EVERY Loan/Other entry to `${monthKey}-01` as a
  // deliberate "no specific date" placeholder — HR types an amount and a reason,
  // never a day. Widening the claim key from category to (category, source) is
  // what makes this dangerous: `other` is written by BOTH the holiday bridge and
  // manual HR entries, and on production 2026-07 the holiday bridge really does
  // charge 2026-07-01. For one employee holding both rows the month's publish
  // would abort on "2026-07-01 → other" — one category named twice, and
  // unresolvable, because clearing either row deletes a real deduction.
  {
    const collisions = findDayCollisions([
      {
        category: "other",
        dates: ["2026-07-01"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "holiday_bridge",
      },
      {
        category: "other",
        dates: ["2026-07-01"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "manual_hr",
      },
    ]);
    assert.deepEqual(
      collisions,
      [],
      "a manual entry's placeholder anchor is not a claim on that day — it must never block a month's publish against a real bridged holiday",
    );
  }

  // Two manual entries share the placeholder day for the same reason.
  {
    const collisions = findDayCollisions([
      {
        category: "other",
        dates: ["2026-07-01"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "manual_hr",
      },
      {
        category: "loan",
        dates: ["2026-07-01"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "manual_hr",
      },
    ]);
    assert.deepEqual(collisions, [], "a Loan and an Other entry both anchored to the 1st are two amounts, not one day charged twice");
  }

  // ── Cross-category detection is unchanged ─────────────────────────────────
  {
    const collisions = findDayCollisions([
      {
        category: "crm",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "crm_visits_mirror",
      },
      {
        category: "fingerprint",
        dates: ["2026-07-07"],
        employeeHrId: "B-124",
        employeeHrIdCompact: "b124",
        sourceSystem: "fingerprint_report",
      },
    ]);
    assert.deepEqual(
      collisions.map((collision) => collision.categories),
      [["crm", "fingerprint"]],
      "the original cross-category gate must keep working — this widened it, it did not replace it",
    );
  }

  // ── A re-run must supersede the stale half, not add to it ─────────────────
  // Supabase-backed, so asserted at the wiring: the collector that owns a
  // vacation category has to reconcile it. Insert-only is what let a CRM
  // candidate written before the HR request was filed stay live and charge the
  // same day a second time.
  {
    const collect = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(collect, /reconcileCandidateDrafts/, "collection must reconcile, not only insert");
    for (const category of ["unpaid_vacation", "insufficient_balance_vacation"]) {
      assert.match(
        collect,
        new RegExp(`reconcilesWholeCategory:\\s*"${category}"`),
        `${category} is written by one collector scanning the whole company, so a re-run must replace its live rows`,
      );
    }
    assert.doesNotMatch(
      collect,
      /reconcilesWholeCategory:\s*"(crm|other)"/,
      "crm and other each have two writers — reconciling one would supersede the other writer's candidates",
    );

    const vacation = readFileSync("src/lib/deductions/connectors/vacation.ts", "utf8");
    assert.match(
      vacation,
      /assertSourceScanned\(/,
      "reconcile retracts what the scan omits, so an empty CRM mirror must fail the run instead of erasing real vacation days",
    );
    assert.equal(
      vacation.match(/return mergeVacationSourcesHrRequestWins\(/g)?.length,
      2,
      "both vacation categories must combine their two sources through the HR-request-wins merge, not concatenate them",
    );
  }
}
