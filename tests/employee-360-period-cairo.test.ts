import assert from "node:assert/strict";

import { resolvePeriod } from "../src/lib/employee-360/period.ts";

// Regression coverage: resolvePeriod used to derive "today", "This month" and YTD
// from the server's UTC clock (`new Date()` / `toISOString`). Between 00:00 and
// ~03:00 Cairo time (EEST, UTC+3) that reads a day behind, or on the 1st a whole
// month behind — a rep opening Employee 360 just after midnight on the 1st saw
// last month labeled "This month". Fixed to derive from currentCairoDateOnlyIso.

export function runEmployee360PeriodCairoTests() {
  // 2026-10-01T22:30:00Z is 2026-10-02 01:30 in Cairo (EEST, UTC+3) — already the 2nd.
  const justAfterMidnightCairo = new Date("2026-10-01T22:30:00Z");

  const last30 = resolvePeriod({ preset: "last30" }, justAfterMidnightCairo);
  assert.equal(last30.current.to, "2026-10-02", '"today" must follow the Cairo calendar, not UTC (which still reads 2026-10-01)');

  const ytd = resolvePeriod({ preset: "ytd" }, justAfterMidnightCairo);
  assert.equal(ytd.current.from, "2026-01-01");
  assert.equal(ytd.current.to, "2026-10-02");
  assert.equal(ytd.current.label.startsWith("2026 year-to-date"), true, "YTD label must use the Cairo year");

  // 2026-09-30T22:30:00Z is 2026-10-01 01:30 in Cairo — already October, while UTC
  // is still on 2026-09-30. This is the exact month-boundary case from the report.
  const monthBoundaryCairo = new Date("2026-09-30T22:30:00Z");

  const thisMonth = resolvePeriod({ preset: "thisMonth" }, monthBoundaryCairo);
  assert.equal(
    thisMonth.current.from,
    "2026-10-01",
    '"This month" must resolve to October in Cairo, not September (the UTC month)',
  );
  assert.equal(thisMonth.current.to, "2026-10-01");
  assert.equal(thisMonth.previous.to, "2026-09-30", "the immediately-preceding day must still be September");

  // thisQuarter must follow the same Cairo-anchored month/year.
  const thisQuarter = resolvePeriod({ preset: "thisQuarter" }, monthBoundaryCairo);
  assert.equal(thisQuarter.current.from, "2026-10-01", "Oct 1 in Cairo starts Q4, not Q3 (the UTC-month quarter)");

  // A UTC instant that is NOT near the Cairo boundary must resolve identically
  // under both readings, so this fix changes nothing away from midnight.
  const midday = new Date("2026-06-15T12:00:00Z");
  const middayThisMonth = resolvePeriod({ preset: "thisMonth" }, midday);
  assert.equal(middayThisMonth.current.from, "2026-06-01");
  assert.equal(middayThisMonth.current.to, "2026-06-15");
}
