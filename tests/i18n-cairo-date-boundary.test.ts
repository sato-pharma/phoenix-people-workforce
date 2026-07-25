import assert from "node:assert/strict";

import { currentCairoDateOnlyIso, currentCairoDateParts } from "../src/lib/i18n/format.ts";

// Cairo is UTC+3 (EEST) roughly late April-late October, UTC+2 (EET) otherwise (same
// live-verified seasonal offsets already used by tests/crm-live-sync-window.test.ts and
// tests/telegram-hardening.test.ts). These pairs straddle the exact minute Cairo's
// calendar day rolls over, in both seasons — the boundary currentCairoDateOnlyIso exists
// to get right where a naive `new Date().toISOString().slice(0, 10)` would not.

export function runI18nCairoDateBoundaryTests() {
  // EEST (summer, UTC+3): Cairo midnight of Jul 25 = Jul 24 21:00 UTC.
  assert.equal(currentCairoDateOnlyIso(new Date("2026-07-24T20:59:00Z")), "2026-07-24", "20:59 UTC (EEST) is still Jul 24 in Cairo");
  assert.equal(currentCairoDateOnlyIso(new Date("2026-07-24T21:00:00Z")), "2026-07-25", "21:00 UTC (EEST) is already Jul 25 in Cairo");

  // EET (winter, UTC+2): Cairo midnight of Jan 16 = Jan 15 22:00 UTC.
  assert.equal(currentCairoDateOnlyIso(new Date("2026-01-15T21:59:00Z")), "2026-01-15", "21:59 UTC (EET) is still Jan 15 in Cairo");
  assert.equal(currentCairoDateOnlyIso(new Date("2026-01-15T22:00:00Z")), "2026-01-16", "22:00 UTC (EET) is already Jan 16 in Cairo");

  // Must agree with currentCairoDateParts (same underlying Intl call) rather than drifting.
  const now = new Date("2026-07-24T21:00:00Z");
  const parts = currentCairoDateParts(now);
  assert.equal(
    currentCairoDateOnlyIso(now),
    `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    "currentCairoDateOnlyIso must agree with currentCairoDateParts for the same instant",
  );

  // Default argument resolves against the live clock without throwing.
  assert.match(currentCairoDateOnlyIso(), /^\d{4}-\d{2}-\d{2}$/, "no-arg call still returns a YYYY-MM-DD string");
}
