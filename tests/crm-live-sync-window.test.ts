import assert from "node:assert/strict";

import { cairoHourMinute, isWithinLiveSyncWindow } from "../src/lib/crm/dates.ts";

// The live-sync cron's exact boundary (see isWithinLiveSyncWindow's own doc comment in
// src/lib/crm/dates.ts): the GCP schedule fires a little wider than 8:30 AM-12:01 PM Cairo (see
// setup-gcp-cron.sh), so this in-code gate is what actually decides whether a firing does real
// work or is a cheap no-op.

// Builds a UTC instant whose Africa/Cairo wall-clock reads exactly {hour}:{minute}. Cairo is
// confirmed UTC+3 in July 2026 (verified live against production: 2026-07-20 09:03 UTC ==
// 2026-07-20 12:03 Cairo), so subtracting 3h from the desired Cairo time gives the UTC instant.
function cairoDate(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 6, 20, hour - 3, minute, 0));
}

export function runCrmLiveSyncWindowTests() {
  assert.equal(isWithinLiveSyncWindow(cairoDate(8, 29)), false, "8:29 AM Cairo is before the window");
  assert.equal(isWithinLiveSyncWindow(cairoDate(8, 30)), true, "8:30 AM Cairo is the window's start, inclusive");
  assert.equal(isWithinLiveSyncWindow(cairoDate(10, 0)), true, "10:00 AM Cairo is inside the window");
  assert.equal(isWithinLiveSyncWindow(cairoDate(12, 1)), true, "12:01 PM Cairo is the window's end, inclusive");
  assert.equal(isWithinLiveSyncWindow(cairoDate(12, 2)), false, "12:02 PM Cairo is after the window");
  assert.equal(isWithinLiveSyncWindow(cairoDate(0, 0)), false, "midnight Cairo is well outside the window");

  const { hour, minute } = cairoHourMinute(cairoDate(9, 15));
  assert.equal(hour, 9, "cairoHourMinute reads back the same hour it was constructed for");
  assert.equal(minute, 15, "cairoHourMinute reads back the same minute it was constructed for");
}
