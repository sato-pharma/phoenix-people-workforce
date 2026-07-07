import assert from "node:assert/strict";

import { computeBridgingWindows } from "../src/lib/payroll/copilot/holiday-bridging.ts";

export function runPayrollCopilotHolidayBridgingTests() {
  const june2026 = { month: 6, year: 2026 };

  // A single-day holiday mid-month produces both a "before" and "after" window.
  {
    const windows = computeBridgingWindows(
      [{ id: "h1", name: "Sham El-Nessim", startDate: "2026-06-15", endDate: null }],
      june2026,
    );
    assert.equal(windows.length, 2);
    assert.deepEqual(
      windows.map((w) => `${w.bridgingDate}:${w.adjacentTo}`).sort(),
      ["2026-06-14:before", "2026-06-16:after"],
    );
  }

  // A multi-day holiday: bridging days are just outside the whole range, not per-day.
  {
    const windows = computeBridgingWindows(
      [{ id: "h2", name: "Eid al-Fitr", startDate: "2026-06-10", endDate: "2026-06-13" }],
      june2026,
    );
    assert.equal(windows.length, 2);
    const before = windows.find((w) => w.adjacentTo === "before");
    const after = windows.find((w) => w.adjacentTo === "after");
    assert.equal(before?.bridgingDate, "2026-06-09");
    assert.equal(after?.bridgingDate, "2026-06-14");
    assert.equal(before?.holidayStartDate, "2026-06-10");
    assert.equal(before?.holidayEndDate, "2026-06-13");
  }

  // A holiday right at month-END: the "after" bridging day falls in the NEXT
  // month, so it must NOT appear for June — only the "before" day (still in June) does.
  {
    const windows = computeBridgingWindows(
      [{ id: "h3", name: "End-of-month holiday", startDate: "2026-06-29", endDate: "2026-06-30" }],
      june2026,
    );
    assert.equal(windows.length, 1);
    assert.equal(windows[0].adjacentTo, "before");
    assert.equal(windows[0].bridgingDate, "2026-06-28");
  }

  // A holiday right at month-START: the "before" bridging day falls in the
  // PRIOR month (May), so only the "after" day (July 2 -- wait, June 1 minus 1
  // is May 31, outside June; June's own holiday starting June 1 means the
  // "after" day depends on its end date). Confirm the prior-month day is excluded.
  {
    const windows = computeBridgingWindows(
      [{ id: "h4", name: "Start-of-month holiday", startDate: "2026-06-01", endDate: "2026-06-01" }],
      june2026,
    );
    assert.equal(windows.length, 1);
    assert.equal(windows[0].adjacentTo, "after");
    assert.equal(windows[0].bridgingDate, "2026-06-02");
  }

  // No holidays -> no windows.
  {
    assert.deepEqual(computeBridgingWindows([], june2026), []);
  }

  // A holiday entirely outside the period contributes nothing.
  {
    const windows = computeBridgingWindows(
      [{ id: "h5", name: "October holiday", startDate: "2026-10-06", endDate: "2026-10-06" }],
      june2026,
    );
    assert.deepEqual(windows, []);
  }
}
