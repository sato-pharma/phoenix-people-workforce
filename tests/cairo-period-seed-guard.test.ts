import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { currentCairoDateParts, currentCairoDateOnlyIso } from "../src/lib/i18n/format.ts";

// Entry points that seed a WORKING PERIOD (YYYY-MM) or a period-derived default into UI state.
//
// These are server components on a UTC runtime. Cairo is ahead of UTC (+2 EET / +3 EEST), so a
// period derived from the raw clock reads the PREVIOUS month for the first 2-3 hours of every
// Cairo month — and each of these seeds something that then gets WRITTEN:
//   - sales/targets      → the grid saves with it, and phx_upsert_monthly_targets is
//                          ON CONFLICT DO UPDATE, so it would overwrite the closed month
//   - automated-payroll  → creates the company's salary run under that period
//   - deductions         → publishes deduction lines under that month_key
//   - finance            → stamps the FAB bank transfer file's value date
//   - m-payroll          → the salary-template download HR fills in and uploads back
const PERIOD_SEEDING_PAGES = [
  "app/(admin)/sales/targets/page.tsx",
  "app/employee-portals/targets/page.tsx",
  "app/(admin)/admin/automated-payroll/page.tsx",
  "app/(admin)/admin/automated-payroll/finance/page.tsx",
  "app/(admin)/admin/deductions/page.tsx",
  "app/(admin)/admin/m-payroll/page.tsx",
] as const;

// Raw-clock date derivation. Deliberately does NOT ban `new Date()` itself — passing the instant
// into currentCairoDateParts(now) is correct, and Date.UTC(...) arithmetic on already-Cairo parts
// is correct too. What is banned is reading a calendar field straight off a clock-derived Date.
const RAW_CLOCK_FIELD_READ = /new Date\(\)\s*\.\s*(get(UTC)?(FullYear|Month|Date)|toISOString)\s*\(/;
const RAW_CLOCK_VIA_LOCAL = /\b(now|today|reference\w*)\s*\.\s*get(FullYear|Month|Date)\s*\(/;
const RAW_CLOCK_VIA_UTC = /\b(now|today)\s*\.\s*getUTC(FullYear|Month|Date)\s*\(/;

export function runCairoPeriodSeedGuardTests() {
  for (const page of PERIOD_SEEDING_PAGES) {
    const source = readFileSync(page, "utf8");

    assert.match(
      source,
      /currentCairoDateParts\(/,
      `${page} must seed its working period from currentCairoDateParts() — a raw-clock period is the previous month for the first 2-3 hours of every Cairo month`,
    );
    assert.doesNotMatch(
      source,
      RAW_CLOCK_FIELD_READ,
      `${page} must not read a calendar field off a clock-derived Date`,
    );
    assert.doesNotMatch(
      source,
      RAW_CLOCK_VIA_LOCAL,
      `${page} must not derive year/month/day from a runtime-local Date`,
    );
    assert.doesNotMatch(
      source,
      RAW_CLOCK_VIA_UTC,
      `${page} must not derive year/month/day from a UTC Date`,
    );
  }

  // The helper itself: Cairo is ahead of UTC, so an instant that is still "yesterday" in UTC must
  // resolve to the NEXT day in Cairo. These two instants are the exact failure window.
  // 2026-07-31T22:30:00Z is 2026-08-01 01:30 Cairo (EEST, +3) — a month rollover.
  const monthRollover = new Date("2026-07-31T22:30:00.000Z");
  assert.deepEqual(
    currentCairoDateParts(monthRollover),
    { year: 2026, month: 8, day: 1 },
    "22:30Z on 31 July is already 1 August in Cairo — the month must roll over",
  );
  assert.equal(currentCairoDateOnlyIso(monthRollover), "2026-08-01");
  assert.notEqual(
    `${monthRollover.getUTCFullYear()}-${String(monthRollover.getUTCMonth() + 1).padStart(2, "0")}`,
    "2026-08",
    "sanity: the UTC-derived month really is the previous one at this instant, so the guard above is meaningful",
  );

  // 2026-12-31T22:30:00Z is 2027-01-01 00:30 Cairo (EET, +2) — a YEAR rollover.
  const yearRollover = new Date("2026-12-31T22:30:00.000Z");
  assert.deepEqual(
    currentCairoDateParts(yearRollover),
    { year: 2027, month: 1, day: 1 },
    "22:30Z on 31 December is already 1 January in Cairo — the year must roll over",
  );

  // Mid-afternoon Cairo: both zones agree, so the fix must be a no-op the rest of the day.
  const midday = new Date("2026-08-01T11:00:00.000Z");
  assert.deepEqual(currentCairoDateParts(midday), { year: 2026, month: 8, day: 1 });
}
