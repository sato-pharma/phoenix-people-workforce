// A bulk leave import must never attribute a day to someone who had not joined yet.
//
// WHY THIS EXISTS. iReports360 identifies a rep by a numeric account, and that account is a SEAT:
// the next rep on the territory inherits it and the vendor renames it to them. A re-sync then
// re-fetches old months and stamps those historical visits with the seat's CURRENT name, so a row's
// name and crm_username describe whoever holds the seat today — not whoever did the work.
//
// `CRM_BACKFILL_2026-08-24` made that mistake once and it reached production: PD-0009, hired
// 2026-08-01, carries an approved leave row dated 2026-02-15, taken from the previous holder of the
// Helwan-Maadi Pedia seat. Nothing caught it, because a pre-hire date breaks no constraint — the
// balance engine refuses to PAY such a day (it lands inside the first-six-months block, unpaid) but
// nothing refuses to CREATE it. It was found by hand on 2026-09-30, when the same trap nearly sent
// 168 March visits and 2 leave days to a rep whose first day is 2026-10-01.
//
// The guard is asserted from both sides. A refusal that also swallowed legitimate rows would be
// switched off the first time it blocked a real import, so the allow half is pinned as hard as the
// deny half — including the boundary day, where leave ON the hire date is real and must pass.

import { strict as assert } from "node:assert";

import { refuseLeaveBeforeHire } from "@/lib/vacation/backfill-guards";

export async function runVacationBackfillHireGuardTests() {
  const today = "2026-09-30";

  // REFUSED — the row that actually reached production. PD-0009, hired 2026-08-01, leave 2026-02-15.
  {
    const verdict = refuseLeaveBeforeHire({ hireDate: "2026-08-01", leaveDate: "2026-02-15", today });
    assert.equal(verdict.ok, false, "a leave 167 days before the hire date must be refused");
    assert.ok(
      !verdict.ok && verdict.reason.includes("2026-08-01") && verdict.reason.includes("2026-02-15"),
      "the reason must name both dates, so the operator can see which row and why",
    );
  }

  // REFUSED — one day before the hire date. The boundary on the deny side.
  assert.equal(
    refuseLeaveBeforeHire({ hireDate: "2026-08-01", leaveDate: "2026-07-31", today }).ok,
    false,
    "the day before the hire date is still before the hire date",
  );

  // REFUSED — the employee has not started at all. PD-0018's first day is 2026-10-01, and his name
  // is already on 168 of the seat's March visits.
  {
    const verdict = refuseLeaveBeforeHire({ hireDate: "2026-10-01", leaveDate: "2026-03-07", today });
    assert.equal(verdict.ok, false, "a future hire must be refused outright");
    assert.ok(!verdict.ok && verdict.reason.includes("has not started"), "the reason must say the person has not started");
  }

  // REFUSED — no hire date, so nothing can be checked. Refusing beats guessing in an import.
  for (const hireDate of [null, undefined, "", "   "]) {
    const verdict = refuseLeaveBeforeHire({ hireDate, leaveDate: "2026-03-07", today });
    assert.equal(verdict.ok, false, `a missing hire date (${JSON.stringify(hireDate)}) must be refused`);
    assert.ok(!verdict.ok && verdict.reason.includes("no hire date"), "the reason must say the hire date is missing");
  }

  // ALLOWED — leave ON the hire date. A real first-day absence, and the boundary on the allow side.
  assert.equal(
    refuseLeaveBeforeHire({ hireDate: "2026-08-01", leaveDate: "2026-08-01", today }).ok,
    true,
    "leave on the hire date itself is legitimate and must pass",
  );

  // ALLOWED — the ordinary case, and a hire date that is exactly today.
  assert.equal(refuseLeaveBeforeHire({ hireDate: "2026-05-02", leaveDate: "2026-09-26", today }).ok, true);
  assert.equal(
    refuseLeaveBeforeHire({ hireDate: today, leaveDate: today, today }).ok,
    true,
    "someone who starts today has started — only a FUTURE hire date is refused",
  );

  // Dates are compared as fixed-width ISO strings, so a year boundary cannot invert the order.
  assert.equal(refuseLeaveBeforeHire({ hireDate: "2026-01-02", leaveDate: "2025-12-31", today }).ok, false);
  assert.equal(refuseLeaveBeforeHire({ hireDate: "2025-12-31", leaveDate: "2026-01-02", today }).ok, true);
}
