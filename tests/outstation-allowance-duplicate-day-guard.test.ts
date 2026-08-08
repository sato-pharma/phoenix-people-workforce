import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { allowanceRowDates, deriveClaimedAllowanceDays } from "../src/lib/outstation/allowance-day-guard.ts";

// Owner-reported bug (2026-08-08): an employee submitted an outstation trip, then separately
// tried to log a same-day meeting expense with its own invoice, and noticed the meeting entry
// would carry a SECOND full day's allowance for a date already paid by the trip. He stopped and
// flagged it before submitting. The owner hit the identical duplication on the very next manual
// expense he tried to create for that employee.
//
// The cause: allowance was a pure function of (tripStartDate, tripEndDate, policy) alone, called
// independently from four different write paths (employee wizard, admin preview, admin create,
// admin edit), none of which had any idea a sibling request already covered part of the span.
//
// Owner's resolution, given verbatim: auto-zero the duplicate day only, show why, and "add a
// guard to never calculate allowance more than once daily." This file pins both halves: the pure
// day-overlap math (assertable without a database, same discipline expense-gate.ts uses for the
// payroll gate), and the WIRING — that all four write paths actually go through the guard and
// cannot silently fall back to the raw, day-blind calculation.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

/** The body of one top-level exported function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in service.ts — this test is pinned to it by name`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

export function runOutstationAllowanceDuplicateDayGuardTests() {
  // ── Pure day-overlap math ────────────────────────────────────────────────────

  {
    // Two requests, same single day, neither rejected: the earlier (lower id) keeps the day.
    const claimed = deriveClaimedAllowanceDays([
      { id: 61, status: "accepted_by_system", tripEndDate: "2026-08-08", tripStartDate: "2026-08-08" },
      { id: 64, status: "submitted", tripEndDate: "2026-08-08", tripStartDate: "2026-08-08" },
    ]);
    assert.equal(
      claimed.get("2026-08-08"),
      61,
      "the lower-id (earlier-created) request must keep a contested day, deterministically — not whichever happens to be read last",
    );
  }

  {
    // A 3-day trip must claim EVERY calendar day of its span, not just the first or last.
    const claimed = deriveClaimedAllowanceDays([
      { id: 1, status: "accepted_by_system", tripEndDate: "2026-08-10", tripStartDate: "2026-08-08" },
    ]);
    assert.deepEqual(
      [...claimed.keys()].sort(),
      ["2026-08-08", "2026-08-09", "2026-08-10"],
      "a multi-day trip must claim every calendar day of its span — a request touching only the first or last day would let the middle days double-pay",
    );
  }

  for (const rejectedStatus of ["rejected_by_system", "rejected_by_admin"]) {
    const claimed = deriveClaimedAllowanceDays([
      { id: 1, status: rejectedStatus, tripEndDate: "2026-08-08", tripStartDate: "2026-08-08" },
      { id: 2, status: "accepted_by_system", tripEndDate: "2026-08-08", tripStartDate: "2026-08-08" },
    ]);
    assert.equal(
      claimed.get("2026-08-08"),
      2,
      `a ${rejectedStatus} request must never hold a day — whatever it would have paid was never real, and it must not block a later legitimate claim on the same date`,
    );
  }

  {
    // excludeRequestId: a request must never be told its OWN previously-claimed days are taken —
    // this is what lets an edit recompute its own allowance without tripping over itself.
    const claimed = deriveClaimedAllowanceDays(
      [{ id: 50, status: "accepted_by_system", tripEndDate: "2026-08-05", tripStartDate: "2026-08-05" }],
      50,
    );
    assert.equal(
      claimed.size,
      0,
      "excluding a request's own id must free its own days — otherwise editing a request would find its own allowance day already 'claimed' and zero itself out",
    );
  }

  {
    // Non-overlapping dates must never collide.
    const claimed = deriveClaimedAllowanceDays([
      { id: 1, status: "accepted_by_system", tripEndDate: "2026-08-05", tripStartDate: "2026-08-05" },
      { id: 2, status: "accepted_by_system", tripEndDate: "2026-08-06", tripStartDate: "2026-08-06" },
    ]);
    assert.equal(claimed.get("2026-08-05"), 1);
    assert.equal(claimed.get("2026-08-06"), 2);
  }

  // allowanceRowDates: row i must be tripStartDate + i days, including across a month boundary —
  // the exact place an off-by-one in UTC day arithmetic would hide.
  assert.deepEqual(allowanceRowDates("2026-08-08", 1), ["2026-08-08"]);
  assert.deepEqual(
    allowanceRowDates("2026-01-30", 3),
    ["2026-01-30", "2026-01-31", "2026-02-01"],
    "row dates must roll over a month boundary correctly — this is exactly where a naive date-string increment breaks",
  );

  // ── Wiring: every write path must go through the guard ──────────────────────

  const service = readFileSync(SERVICE, "utf8");

  assert.ok(
    !/^\s*export (async )?function calculateAllowanceBreakdown\(/m.test(service),
    "the old bare calculateAllowanceBreakdown must not exist as an exported function — every caller must go through the guarded version",
  );
  assert.ok(
    !/^function calculateRawAllowanceBreakdown/m.test(service) ||
      !/^export/m.test(service.slice(service.indexOf("function calculateRawAllowanceBreakdown") - 1, service.indexOf("function calculateRawAllowanceBreakdown"))),
    "calculateRawAllowanceBreakdown (the day-blind calculation) must stay un-exported — exporting it would let a future call site outside this file bypass the guard entirely",
  );

  const writePaths = [
    "calculateOutstationExpense",
    "previewManagerExpenseCalculation",
    "createManagerExpenseAsAdmin",
    "updateManagerExpenseAsAdmin",
  ];
  for (const name of writePaths) {
    const body = functionBody(service, name);
    assert.ok(
      /calculateGuardedAllowanceBreakdown\(/.test(body),
      `${name} must compute allowance through calculateGuardedAllowanceBreakdown — this is one of the four places the original bug came from, and a path that reverts to the raw calculation reintroduces same-day double payment`,
    );
    assert.ok(
      !/[^d]calculateRawAllowanceBreakdown\(/.test(body),
      `${name} must not call calculateRawAllowanceBreakdown directly — that is the day-blind calculation the guard exists to wrap`,
    );
  }

  // The two paths named explicitly in the bug report — the employee's trip submission and the
  // owner's own manual expense — must also show the reason to a human, not only zero the number.
  for (const name of ["calculateOutstationExpense", "createManagerExpenseAsAdmin"]) {
    assert.ok(
      functionBody(service, name).includes("appendAllowanceGuardNote") ||
        service.includes("appendAllowanceGuardNote(calculation.notes"),
      `${name}'s request must carry a human-readable reason when a day is zeroed — the employee who reported this asked specifically to never wonder whether a missing allowance line is a bug`,
    );
  }
}
