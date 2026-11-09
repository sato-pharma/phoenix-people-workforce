import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  computeHolidayBridgeDays,
  excludeAlreadyDeductedDays,
  isBeforeHireDate,
  isFieldForceWorkingDay,
  type HolidayInput,
} from "../src/lib/deductions/holiday-bridge.ts";

function bridge(holidays: HolidayInput[], monthKey: string) {
  return computeHolidayBridgeDays({ holidays, monthKey, isWorkingDay: isFieldForceWorkingDay });
}

function dates(result: ReturnType<typeof bridge>) {
  return result.map((entry) => `${entry.date}:${entry.adjacentTo}`);
}

export async function runDeductionsHolidayBridgeTests(): Promise<void> {
  // Anchor the weekday assumptions this whole file rests on, so a wrong date in
  // a fixture fails loudly here rather than silently making every other
  // assertion meaningless.
  {
    assert.equal(new Date("2026-10-06T00:00:00Z").getUTCDay(), 2, "2026-10-06 must be a Tuesday");
    assert.equal(new Date("2026-06-25T00:00:00Z").getUTCDay(), 4, "2026-06-25 must be a Thursday");
    assert.equal(isFieldForceWorkingDay("2026-10-09"), false, "Friday is not a working day for the field force");
    assert.equal(isFieldForceWorkingDay("2026-10-10"), true, "Saturday IS a working day for the field force");
  }

  // ── A bridge day before the hire date is never charged ───────────────────
  // Owner report 2026-11-09: reps hired 11 October were flagged "no record" on 7 and 10 October.
  {
    assert.equal(isBeforeHireDate("2026-10-07", "2026-10-11"), true, "7 October is before an 11 October hire");
    assert.equal(isBeforeHireDate("2026-10-10", "2026-10-11"), true, "10 October is before an 11 October hire");
    assert.equal(isBeforeHireDate("2026-10-11", "2026-10-11"), false, "the hire day itself is a working day he can be charged for");
    assert.equal(isBeforeHireDate("2026-10-07", "2026-09-01"), false, "an earlier hire is charged as before");
    assert.equal(isBeforeHireDate("2026-10-07", null), false, "no hire date on record keeps the old behaviour");
    // The connector must read the hire date and ask the rule for every employee-day.
    const connector = readFileSync("src/lib/deductions/connectors/holiday-bridge.ts", "utf8");
    assert.ok(connector.includes(`employment_status, hire_date")`), "the field-force roster must select hire_date");
    assert.ok(
      connector.includes("if (isBeforeHireDate(bridge.date, employee.hireDate)) continue;"),
      "the bridge loop must skip every day before the employee's hire date",
    );
  }

  // ── A mid-week holiday bridges its plain calendar neighbours ─────────────
  // 6 October 2026 is a Tuesday, so nothing needs stepping over.
  {
    const result = bridge([{ id: "h1", name: "Armed Forces Day", startDate: "2026-10-06", endDate: null }], "2026-10");
    assert.deepEqual(
      dates(result),
      ["2026-10-05:before", "2026-10-07:after"],
      "a Tuesday holiday bridges Monday and Wednesday",
    );
  }

  // ── A Thursday holiday steps OVER Friday to Saturday ─────────────────────
  // This is the case the owner described. Wednesday and Saturday are the
  // RESULT here, not a hardcoded pair — the rule is "nearest working day".
  {
    const result = bridge([{ id: "h2", name: "National Day", startDate: "2026-06-25", endDate: null }], "2026-06");
    assert.deepEqual(
      dates(result),
      ["2026-06-24:before", "2026-06-27:after"],
      "a Thursday holiday must bridge Wednesday and SATURDAY — Friday is never worked, so flagging it would catch every rep every time",
    );
    assert.equal(
      result.some((entry) => entry.date === "2026-06-26"),
      false,
      "the Friday itself must never be flagged",
    );
  }

  // ── A multi-day holiday bridges the ENDS of the block, not each day ──────
  {
    const result = bridge(
      [{ id: "h3", name: "Eid", startDate: "2026-10-06", endDate: "2026-10-08" }],
      "2026-10",
    );
    assert.deepEqual(
      dates(result),
      ["2026-10-05:before", "2026-10-10:after"],
      "a Tue-Thu holiday bridges Monday and Saturday — the Friday inside the tail is stepped over, and 07/08 are holiday days, not bridges",
    );
  }

  // ── Two holidays separated only by non-working days act as ONE block ─────
  {
    const result = bridge(
      [
        { id: "h4", name: "Holiday A", startDate: "2026-10-08", endDate: null },
        { id: "h5", name: "Holiday B", startDate: "2026-10-10", endDate: null },
      ],
      "2026-10",
    );
    assert.equal(
      result.some((entry) => entry.date === "2026-10-09"),
      false,
      "the Friday between two holidays must not become a bridge day — nobody worked it",
    );
    assert.deepEqual(
      [...new Set(result.map((entry) => entry.date))].sort(),
      ["2026-10-07", "2026-10-11"],
      "the block spans both holidays, so only its outer working neighbours bridge",
    );
  }

  // ── A bridge day outside the month is not returned ───────────────────────
  // The holiday can sit in the next month while its bridging day falls in this
  // one, and vice versa — only days inside the requested month belong to it.
  {
    const result = bridge([{ id: "h6", name: "Armed Forces Day", startDate: "2026-10-06", endDate: null }], "2026-09");
    assert.deepEqual(dates(result), [], "an October holiday contributes no September bridge day here");

    const spanning = bridge([{ id: "h7", name: "New Month Day", startDate: "2026-10-01", endDate: null }], "2026-09");
    assert.deepEqual(
      dates(spanning),
      ["2026-09-30:before"],
      "a holiday on the 1st still bridges the last working day of the PRIOR month",
    );
  }

  // ── Never charge the same employee-day twice ─────────────────────────────
  // The publish-time collision gate would refuse the entire month over such an
  // overlap, so the duplicate must never be created in the first place.
  {
    const days = bridge([{ id: "h8", name: "Armed Forces Day", startDate: "2026-10-06", endDate: null }], "2026-10");
    const kept = excludeAlreadyDeductedDays({
      bridgeDays: days,
      alreadyDeducted: new Set(["b124:2026-10-05"]),
      employeeHrIdCompact: "b124",
    });
    assert.deepEqual(
      dates(kept),
      ["2026-10-07:after"],
      "a day already deducted as unpaid vacation / no-balance / no-record must not be charged again as a bridge day",
    );

    const untouched = excludeAlreadyDeductedDays({
      bridgeDays: days,
      alreadyDeducted: new Set(["someoneelse:2026-10-05"]),
      employeeHrIdCompact: "b124",
    });
    assert.equal(untouched.length, 2, "another employee's deduction on that day must not suppress this one");
  }
}
