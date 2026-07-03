import { strict as assert } from "node:assert";

import {
  addDays,
  inclusiveDayCount,
  resolveDigestCycle,
  settlementWeekForDate,
  tileSettlementWeeks,
} from "../src/lib/attendance/digest-cycle.ts";

export function runAttendanceDigestCycleTests() {
  // --- date helpers ---
  assert.equal(addDays("2026-07-23", 1), "2026-07-24");
  assert.equal(addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01", "2026 is not a leap year");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01", "year boundary");
  assert.equal(inclusiveDayCount("2026-06-24", "2026-07-23"), 30);
  assert.equal(inclusiveDayCount("2026-07-15", "2026-07-15"), 1);

  // --- resolveDigestCycle (anchor 24) ---
  const midJuly = resolveDigestCycle("2026-07-03", 24);
  assert.equal(midJuly.startIso, "2026-06-24", "a date before the 24th belongs to the prior-month cycle");
  assert.equal(midJuly.endIso, "2026-07-23");
  assert.equal(midJuly.cycleKey, "2026-07");

  const onAnchor = resolveDigestCycle("2026-07-24", 24);
  assert.equal(onAnchor.startIso, "2026-07-24", "the anchor day starts the next cycle");
  assert.equal(onAnchor.endIso, "2026-08-23");
  assert.equal(onAnchor.cycleKey, "2026-08");

  const janBackToDec = resolveDigestCycle("2026-01-10", 24);
  assert.equal(janBackToDec.startIso, "2025-12-24", "January before the 24th reaches back to December");
  assert.equal(janBackToDec.endIso, "2026-01-23");
  assert.equal(janBackToDec.cycleKey, "2026-01");

  const decForward = resolveDigestCycle("2026-12-25", 24);
  assert.equal(decForward.startIso, "2026-12-24");
  assert.equal(decForward.endIso, "2027-01-23", "December after the 24th rolls into next year");
  assert.equal(decForward.cycleKey, "2027-01");

  // --- tileSettlementWeeks: exactly four, weeks 1-3 are 7 days, week 4 absorbs the rest ---
  const weeks = tileSettlementWeeks(midJuly);
  assert.equal(weeks.length, 4, "always exactly four settlement weeks");
  assert.deepEqual(
    weeks.map((week) => week.index),
    [1, 2, 3, 4],
  );
  for (const index of [0, 1, 2]) {
    assert.equal(inclusiveDayCount(weeks[index].startIso, weeks[index].endIso), 7, "weeks 1-3 are seven days");
  }
  assert.equal(weeks[3].startIso, "2026-07-15");
  assert.equal(weeks[3].endIso, "2026-07-23");
  assert.equal(inclusiveDayCount(weeks[3].startIso, weeks[3].endIso), 9, "week 4 absorbs the extra days");

  // Weeks are contiguous and cover the whole cycle with no gaps or overlaps.
  assert.equal(weeks[0].startIso, midJuly.startIso);
  assert.equal(weeks[3].endIso, midJuly.endIso);
  for (const index of [1, 2, 3]) {
    assert.equal(weeks[index].startIso, addDays(weeks[index - 1].endIso, 1), "no gap between consecutive weeks");
  }
  const totalDays = weeks.reduce((sum, week) => sum + inclusiveDayCount(week.startIso, week.endIso), 0);
  assert.equal(totalDays, inclusiveDayCount(midJuly.startIso, midJuly.endIso), "the four weeks tile the full cycle");

  // --- settlementWeekForDate ---
  assert.equal(settlementWeekForDate("2026-06-24", midJuly), 1);
  assert.equal(settlementWeekForDate("2026-06-30", midJuly), 1);
  assert.equal(settlementWeekForDate("2026-07-01", midJuly), 2);
  assert.equal(settlementWeekForDate("2026-07-14", midJuly), 3);
  assert.equal(settlementWeekForDate("2026-07-15", midJuly), 4);
  assert.equal(settlementWeekForDate("2026-07-23", midJuly), 4);
  assert.equal(settlementWeekForDate("2026-07-24", midJuly), null, "a date past the cycle end is outside");
  assert.equal(settlementWeekForDate("2026-06-23", midJuly), null, "a date before the cycle start is outside");
}
