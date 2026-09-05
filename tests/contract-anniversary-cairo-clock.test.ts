import assert from "node:assert/strict";

import { nextContractAnniversary } from "../src/lib/contracts/date-rules.ts";

export function runContractAnniversaryCairoClockTests() {
  // 2026-09-04T23:30:00Z is 2026-09-05 01:30 in Africa/Cairo (UTC+3, no DST) — already the next
  // calendar day there, even though the UTC/server-local instant (Railway's production clock)
  // is still 2026-09-04. A contract whose anniversary falls on 2026-09-04 has therefore ALREADY
  // PASSED by the time this instant is read, so "next" must roll to 2027-09-04 — reporting the
  // already-elapsed 2026-09-04 as still due is the bug this test pins.
  const cairoNextDay = new Date("2026-09-04T23:30:00Z");
  assert.equal(
    nextContractAnniversary("2020-09-04", cairoNextDay),
    "2027-09-04",
    "an anniversary that has already passed in Africa/Cairo must roll to next year, even while the UTC/server-local calendar day has not yet turned over",
  );

  // Contrast case: an instant on the SAME Cairo calendar day as the anniversary
  // (2026-09-04T10:00:00Z is 2026-09-04 13:00 Cairo) must still return that same-day
  // anniversary rather than pre-emptively skipping to the following year — the fix has to
  // resolve the correct Cairo day, not simply always advance by one year.
  const cairoSameDay = new Date("2026-09-04T10:00:00Z");
  assert.equal(
    nextContractAnniversary("2020-09-04", cairoSameDay),
    "2026-09-04",
    "an anniversary falling on the same Cairo calendar day as the reference instant is still the next (today's) anniversary",
  );
}
