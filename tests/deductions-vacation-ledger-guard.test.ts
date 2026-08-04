import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  clipLeaveToMonth,
  excludeAlreadyClaimedVacationDays,
} from "../src/lib/deductions/connectors/vacation.ts";

// THE DEFECT THIS PINS.
//
// collectUnpaidVacationCandidates emits from TWO sources whose candidate keys
// differ — `crm-vacation:{HR_ID}:{DATE}:{category}` from the CRM signal, and
// `vacation:{requestUuid}:{category}` from the HR request. Same employee, same
// day, same category, DIFFERENT key, so the partial unique index on
// (category, candidate_key) cannot see the collision and neither can
// insertCandidateDrafts' key probe.
//
// The CRM path defers to an HR request (`if (covered) continue`). The request
// path had no matching check, so re-running a month that already held
// CRM-signal candidates charged those days twice: on 2026-08-03, 23 rows where
// 7 were due and 13 duplicate employee-days in July 2026 (119 live → 135,
// 107,477.66 EGP). Withdrawn; nothing published.
//
// Note what does NOT catch it: findDayCollisions reports a day only when more
// than one CATEGORY claims it, and both of these rows are unpaid_vacation.
//
// The guard behaviour is a pure function so it can be asserted directly; the
// ledger read around it is DB-bound and pinned as wiring, the same way
// deductions-dsm-no-record.test.ts does.

const HR = "b124";

function claim(...keys: string[]): ReadonlySet<string> {
  return new Set(keys);
}

export async function runDeductionsVacationLedgerGuardTests(): Promise<void> {
  // ── The regression: a fully-claimed request must produce nothing ──────────
  // Every in-month day is already charged by a live crm_vacation_signal
  // candidate from an earlier run. Emitting here is the duplicate.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-08",
      monthKey: "2026-07",
      totalUnpaidDays: 3,
    });
    assert.equal(clipped.datesInMonth.length, 3, "fixture: the request must clip to three July days");

    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(`${HR}:2026-07-06`, `${HR}:2026-07-07`, `${HR}:2026-07-08`),
      employeeHrIdCompact: HR,
    });
    assert.deepEqual(
      result.datesInMonth,
      [],
      "every day is already charged by another live candidate, so this request must emit NO day at all",
    );
    assert.equal(
      result.daysInMonth,
      0,
      "a request whose days are all already charged must carry zero days, not its own unpaid total",
    );
    assert.deepEqual(result.droppedDates, ["2026-07-06", "2026-07-07", "2026-07-08"]);
  }

  // ── Partial overlap must NOT skip the whole request ───────────────────────
  // The days that are free are still owed. Dropping the draft entirely would
  // under-deduct, which is the opposite mistake and just as wrong.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-09",
      monthKey: "2026-07",
      totalUnpaidDays: 4,
    });
    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(`${HR}:2026-07-07`),
      employeeHrIdCompact: HR,
    });
    assert.deepEqual(
      result.datesInMonth,
      ["2026-07-06", "2026-07-08", "2026-07-09"],
      "only the claimed day is dropped — the other three are still owed and must survive",
    );
    assert.equal(
      result.daysInMonth,
      3,
      "the day count must be RECOMPUTED from the surviving days (4 → 3), or the amount would still charge for the dropped one",
    );
    assert.deepEqual(result.droppedDates, ["2026-07-07"]);
  }

  // ── A boundary-spanning request prorates twice, in order ──────────────────
  // clipLeaveToMonth already apportioned 10 unpaid days across a 10-day span
  // down to the 5 that fall in July. Dropping one of those 5 must apportion
  // again off that clipped value, not off the request's raw total.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-06-27",
      endDate: "2026-07-06",
      monthKey: "2026-07",
      totalUnpaidDays: 10,
    });
    assert.equal(clipped.datesInMonth.length, 6, "fixture: 1–6 July fall in the month");
    assert.equal(clipped.daysInMonth, 6, "fixture: 10 unpaid days across a 10-day span is 6 in July");

    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(`${HR}:2026-07-01`, `${HR}:2026-07-02`),
      employeeHrIdCompact: HR,
    });
    assert.equal(
      result.daysInMonth,
      4,
      "two of six in-month days already charged leaves four — the pro-rata must compose with the month clip, not replace it",
    );
    assert.deepEqual(result.datesInMonth, ["2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"]);
  }

  // ── A fractional unpaid total stays fractional ───────────────────────────
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-07",
      monthKey: "2026-07",
      totalUnpaidDays: 1.5,
    });
    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(`${HR}:2026-07-06`),
      employeeHrIdCompact: HR,
    });
    assert.equal(result.daysInMonth, 0.75, "half of a 1.5-day request is 0.75, rounded to two places");
  }

  // ── Another employee's deduction must not suppress this one ──────────────
  // The ledger key is `${compactHrId}:${date}`; matching on the date alone
  // would silently drop everyone who took leave on a day anybody was charged.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-06",
      monthKey: "2026-07",
      totalUnpaidDays: 1,
    });
    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(`someoneelse:2026-07-06`),
      employeeHrIdCompact: HR,
    });
    assert.deepEqual(result.datesInMonth, ["2026-07-06"], "another employee's charge on that day must not suppress this one");
    assert.equal(result.daysInMonth, 1);
    assert.deepEqual(result.droppedDates, []);
  }

  // ── Inert when nothing is claimed ────────────────────────────────────────
  // The normal path — the overwhelming majority of rows — must come out of the
  // guard byte-identical to what it went in as, or this fix silently repriced
  // every unpaid vacation in the system.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-09",
      monthKey: "2026-07",
      totalUnpaidDays: 2.5,
    });
    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(),
      employeeHrIdCompact: HR,
    });
    assert.deepEqual(result.datesInMonth, clipped.datesInMonth, "an unclaimed request keeps every one of its days");
    assert.equal(result.daysInMonth, clipped.daysInMonth, "an unclaimed request keeps its clipped day count exactly");
    assert.deepEqual(result.droppedDates, []);
  }

  // ── An unusable hr-id drops nothing ──────────────────────────────────────
  // An empty compact would build the key `:2026-07-06` and match any other
  // unidentified row, suppressing a real deduction on a coincidence.
  {
    const clipped = clipLeaveToMonth({
      startDate: "2026-07-06",
      endDate: "2026-07-06",
      monthKey: "2026-07",
      totalUnpaidDays: 1,
    });
    const result = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted: claim(":2026-07-06"),
      employeeHrIdCompact: null,
    });
    assert.deepEqual(result.datesInMonth, ["2026-07-06"], "no usable compact id means no ledger match, so nothing is dropped");
  }

  // ── WIRING: the connector must actually use the guard ────────────────────
  // The pure function above proves the arithmetic. It proves nothing about the
  // HR-request path calling it — which is the entire defect. Assert against
  // executable lines, because this file documents the incident at length in
  // comments that would satisfy a raw-text match.
  {
    const source = readFileSync("src/lib/deductions/connectors/vacation.ts", "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    assert.match(
      code,
      /superseded_at/,
      "the connector must read the live ledger (superseded_at is null) — a withdrawn candidate frees its day again",
    );
    assert.match(
      code,
      /employee_hr_id_compact,\s*dates/,
      "the ledger read must select employee_hr_id_compact and dates, the two columns the claimed-day key is built from",
    );
    assert.match(
      code,
      /const\s+afterLedger\s*=\s*excludeAlreadyClaimedVacationDays\(/,
      "the HR-request path must run its clipped days through excludeAlreadyClaimedVacationDays — this is the guard that was missing",
    );
    assert.match(
      code,
      /deductionDays:\s*afterLedger\.daysInMonth/,
      "the amount must be priced off the SURVIVING days, or a dropped day is still paid for",
    );
    assert.match(
      code,
      /rawValue:\s*afterLedger\.daysInMonth/,
      "the candidate's quantity must be the surviving day count, not the pre-guard one",
    );
    assert.match(
      code,
      /dates:\s*afterLedger\.datesInMonth/,
      "the candidate must claim only the surviving days, or the ledger and the collision gate disagree",
    );
    assert.doesNotMatch(
      code,
      /dates:\s*clipped\.datesInMonth/,
      "no draft may still be built from the pre-guard clipped dates",
    );

    // The CRM path's own half of the guard must stay. Removing it would just
    // move the duplicate to the other side.
    assert.match(
      code,
      /if\s*\(covered\)\s*continue/,
      "the CRM path must keep deferring to an HR request — the two halves only work as a pair",
    );
  }
}
