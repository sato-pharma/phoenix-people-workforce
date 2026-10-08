import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decisionForSettlement, effectiveSettlement } from "../src/lib/attendance/digest-rules.ts";

/**
 * A WEEKLY-REVIEW DISPUTE THAT IS DECIDED TWICE.
 *
 * The owner's ruling (2026-10-09): a decided dispute can be reopened and decided again — "employee
 * asks, reviewer reopens" — and that must hold for the weekly attendance review as well as the other
 * two modules.
 *
 * The obstacle: a settlement row is written ONCE per day and never changed (the settle function
 * refuses a second one), and the month-end deduction, the leave ledger and the Deductions module's
 * own "was this day already cleared?" guard all read settlements. So a revision moves the LINE, and
 * for a dispute outcome the line becomes the truth with the settlement as its first draft.
 *
 * What this pins is the hole that would otherwise open: a day upheld, then reopened and REJECTED,
 * still being treated as upheld by month-end — the employee keeps money they were re-charged for, or
 * is charged twice, depending on which reader you ask. Each reader must get the SAME answer.
 */

export async function runDisputeCenterDigestRevisionTests() {
  // Nothing revised: the settlement stands exactly as written, for every kind of answer.
  for (const action of ["salary", "annual_balance", "removed", "confirmed", "dispute_upheld", "dispute_rejected"]) {
    const unchanged = effectiveSettlement({ action, method: "salary" }, { action, chosenMethod: "salary" });
    assert.equal(unchanged.action, action, `${action} is untouched when the line still agrees`);
    assert.equal(unchanged.revised, false, `${action} is not reported as revised`);
  }

  // A day UPHELD and then re-decided as REJECTED: the line wins, and the method comes from the line.
  const nowRejected = effectiveSettlement(
    { action: "dispute_upheld", method: null },
    { action: "dispute_rejected", chosenMethod: "annual_balance" },
  );
  assert.equal(nowRejected.action, "dispute_rejected", "the revised outcome is what every reader sees");
  assert.equal(nowRejected.method, "annual_balance", "…paid the way the line now says");
  assert.equal(nowRejected.revised, true, "and it is flagged as revised");

  // A rejected day with no method on the line falls back to SALARY — never to a null that a reader
  // would quietly treat as "nothing to take".
  const noMethod = effectiveSettlement({ action: "dispute_upheld", method: null }, { action: "dispute_rejected", chosenMethod: null });
  assert.equal(noMethod.method, "salary", "a rejected day with no method recorded is taken from salary, not from nothing");

  // The other direction: REJECTED and then upheld. The upheld day keeps the settlement's method,
  // because an upheld day is not charged at all and the method is immaterial.
  const nowUpheld = effectiveSettlement(
    { action: "dispute_rejected", method: "salary" },
    { action: "dispute_upheld", chosenMethod: "salary" },
  );
  assert.equal(nowUpheld.action, "dispute_upheld", "an upheld revision is read as upheld");
  assert.equal(nowUpheld.revised, true);

  // A MISSING line is never a revision — it is a read that failed, and the settlement must stand.
  for (const line of [null, undefined, { action: null, chosenMethod: null }]) {
    const noLine = effectiveSettlement({ action: "dispute_upheld", method: "salary" }, line);
    assert.equal(noLine.action, "dispute_upheld", "with no line to read, the settlement stands");
    assert.equal(noLine.revised, false);
  }

  // Only a dispute OUTCOME is revisable this way. A line that moved to "removed" or to a plain
  // method must not silently rewrite a settled dispute — those paths have their own rules.
  const notAnOutcome = effectiveSettlement({ action: "dispute_upheld", method: "salary" }, { action: "removed", chosenMethod: null });
  assert.equal(notAnOutcome.action, "dispute_upheld", "a non-outcome line never overrides a settled dispute outcome");
  assert.equal(notAnOutcome.revised, false);
  const notASettledOutcome = effectiveSettlement({ action: "salary", method: "salary" }, { action: "dispute_upheld", chosenMethod: null });
  assert.equal(notASettledOutcome.action, "salary", "and a settlement that was never a dispute is not revisable by the line");

  // END TO END on the thing that actually moves money: a revised day must produce the OTHER payroll
  // decision, not the original one.
  const revisedToSalary = effectiveSettlement(
    { action: "dispute_upheld", method: null },
    { action: "dispute_rejected", chosenMethod: "salary" },
  );
  const upheldDecision = decisionForSettlement("dispute_upheld", null);
  const rejectedDecision = decisionForSettlement(revisedToSalary.action, revisedToSalary.method);
  assert.ok(upheldDecision, "an upheld day has a decision");
  assert.ok(rejectedDecision, "a rejected day has a decision");
  assert.equal(upheldDecision!.status, "Do Not Take Action", "an upheld day is not charged at all");
  assert.equal(
    rejectedDecision!.status,
    "Approved for Payroll",
    "the revision flips the payroll decision — which is the whole reason the line must be read",
  );
  assert.equal(
    decisionForSettlement("dispute_rejected", "annual_balance")!.status,
    "Do Not Take Action",
    "a day taken from the annual balance is never ALSO a payroll deduction",
  );

  // EVERY reader of a settled day reads it through effectiveSettlement. A reader that does not is
  // the hole: it answers from the first decision for ever.
  const bridge = readFileSync("src/lib/attendance/digest-bridge.ts", "utf8");
  assert.ok(bridge.includes("effectiveSettlement("), "the month-end bridge reads the effective answer, not the settlement row");
  assert.ok(
    bridge.includes("action,chosen_method") || bridge.includes("action, chosen_method"),
    "…so it must select the line's own action and method",
  );
  assert.ok(
    !/const decision = decisionFor\(settlement\.action/.test(bridge),
    "the bridge no longer decides from the settlement's own action",
  );

  const deductions = readFileSync("src/lib/deductions/service.ts", "utf8");
  const guardStart = deductions.indexOf("async function assertDayNotClearedInAttendanceReview");
  assert.ok(guardStart > 0, "the deductions approval guard exists");
  const guard = deductions.slice(guardStart, guardStart + 5000);
  assert.ok(
    guard.includes("effectiveSettlement("),
    "the guard that refuses a deduction for an already-cleared day reads the revised answer too",
  );
  assert.ok(
    guard.includes("attendance_digest_lines!inner(action,chosen_method"),
    "…which means it selects the line beside the settlement",
  );

  // The revision itself goes through the database function, under one transaction, because it moves
  // the line AND reverses a leave charge. A hand-rolled update would do half of it.
  const digest = readFileSync("src/lib/dispute-center/digest.ts", "utf8");
  assert.ok(
    digest.includes("phx_attendance_revise_digest_dispute"),
    "a second decision on a weekly-review day goes through the revise function",
  );
  assert.ok(
    digest.includes("reopenedSince("),
    "…and only after the case was really reopened — a reviewer cannot re-decide a closed day on a whim",
  );
  const migration = readFileSync("supabase/migrations/20261009120000_dispute_center.sql", "utf8");
  assert.ok(
    migration.includes("phx_attendance_revise_digest_dispute"),
    "the function is created by the migration this branch carries",
  );
  assert.ok(
    migration.includes("reverses_charge_id"),
    "a leave day given back is a REVERSING entry, never a deleted charge — the ledger stays append-only",
  );
}
