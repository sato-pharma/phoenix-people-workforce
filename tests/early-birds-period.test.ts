import assert from "node:assert/strict";

import {
  EARLY_BIRDS_PERIOD_KEY_PATTERN,
  daysInMonth,
  earlyBirdsPeriodDays,
  earlyBirdsPeriodForDate,
  earlyBirdsPeriodFromKey,
  isEarlyBirdsPeriodClosed,
  isEarlyBirdsPeriodKey,
  listRecentEarlyBirdsPeriods,
  nextEarlyBirdsPeriod,
  previousEarlyBirdsPeriod,
} from "../src/lib/early-birds/period.ts";

// Early Birds awards a fortnight, so every boundary decision here decides which fortnight a rep's
// work counts toward. The two failures this file exists to prevent: snapshotting a period on its
// own last day (while that day's visits are still arriving), and a key TypeScript mints being
// rejected by the migration's CHECK constraint at 03:00 with nobody watching.

export function runEarlyBirdsPeriodTests() {
  // ── The two halves of a month ───────────────────────────────────────────────────
  {
    for (const day of ["01", "07", "15"]) {
      const period = earlyBirdsPeriodForDate(`2026-08-${day}`);
      assert.equal(period.periodKey, "2026-08-H1", `the ${day}th belongs to the first half`);
      assert.equal(period.startIso, "2026-08-01");
      assert.equal(period.endIso, "2026-08-15");
    }
    for (const day of ["16", "23", "31"]) {
      const period = earlyBirdsPeriodForDate(`2026-08-${day}`);
      assert.equal(period.periodKey, "2026-08-H2", `the ${day}th belongs to the second half`);
      assert.equal(period.startIso, "2026-08-16");
      assert.equal(period.endIso, "2026-08-31");
    }
  }

  // ── H2 ends on the real month end, including February ───────────────────────────
  {
    assert.equal(daysInMonth(2026, 2), 28, "2026 is not a leap year");
    assert.equal(daysInMonth(2028, 2), 29, "2028 is");
    assert.equal(earlyBirdsPeriodForDate("2026-02-20").endIso, "2026-02-28");
    assert.equal(earlyBirdsPeriodForDate("2028-02-20").endIso, "2028-02-29");
    assert.equal(earlyBirdsPeriodForDate("2026-04-20").endIso, "2026-04-30");
  }

  // ── Stepping across a year boundary ─────────────────────────────────────────────
  {
    assert.equal(previousEarlyBirdsPeriod(earlyBirdsPeriodFromKey("2026-01-H1")).periodKey, "2025-12-H2");
    assert.equal(nextEarlyBirdsPeriod(earlyBirdsPeriodFromKey("2025-12-H2")).periodKey, "2026-01-H1");
    assert.equal(previousEarlyBirdsPeriod(earlyBirdsPeriodFromKey("2026-08-H2")).periodKey, "2026-08-H1");
    assert.equal(nextEarlyBirdsPeriod(earlyBirdsPeriodFromKey("2026-08-H1")).periodKey, "2026-08-H2");
  }

  // ── Keys sort lexicographically in chronological order ──────────────────────────
  {
    const walked = listRecentEarlyBirdsPeriods("2026-08-20", 6).map((period) => period.periodKey);
    const sorted = [...walked].sort();
    assert.deepEqual(
      sorted,
      [...walked].reverse(),
      "listRecent walks backwards, so plain string sort must reproduce it reversed — this is what lets `order by period_key` be chronological with no parsing",
    );
  }

  // ── Round-trip and rejection ────────────────────────────────────────────────────
  {
    for (const period of listRecentEarlyBirdsPeriods("2026-08-20", 5)) {
      assert.equal(earlyBirdsPeriodFromKey(period.periodKey).startIso, period.startIso);
      assert.equal(earlyBirdsPeriodFromKey(period.periodKey).endIso, period.endIso);
    }
    for (const bad of ["2026-13-H1", "2026-08-H3", "2026-8-H1", "", "2026-08", "2026-00-H1"]) {
      assert.equal(isEarlyBirdsPeriodKey(bad), false, `"${bad}" must not be a valid period key`);
      assert.throws(() => earlyBirdsPeriodFromKey(bad), `"${bad}" must throw rather than silently resolve`);
    }
  }

  // ── A period is NOT closed on its own last day ──────────────────────────────────
  {
    const period = earlyBirdsPeriodFromKey("2026-08-H1");
    assert.equal(
      isEarlyBirdsPeriodClosed(period, "2026-08-15"),
      false,
      "closing on the end date itself would snapshot the fortnight while its final day's visits are still being submitted",
    );
    assert.equal(isEarlyBirdsPeriodClosed(period, "2026-08-16"), true, "closed the day after");
  }

  // ── The TS pattern and the SQL CHECK pattern must be the same string ────────────
  {
    assert.equal(
      EARLY_BIRDS_PERIOD_KEY_PATTERN,
      "^[0-9]{4}-(0[1-9]|1[0-2])-H[12]$",
      "the migration's CHECK constraint pins this exact pattern — if they drift, a key TypeScript happily mints is rejected by the database inside an unattended 03:00 job",
    );
    assert.equal(isEarlyBirdsPeriodKey("2026-08-H1"), true);
    assert.equal(isEarlyBirdsPeriodKey("2026-12-H2"), true);
  }

  // ── Period days, and the clamp that stops a live preview counting future days ───
  {
    const h1 = earlyBirdsPeriodFromKey("2026-08-H1");
    assert.equal(earlyBirdsPeriodDays(h1).length, 15);
    assert.equal(earlyBirdsPeriodDays(h1)[0], "2026-08-01");
    assert.equal(earlyBirdsPeriodDays(h1)[14], "2026-08-15");
    assert.deepEqual(
      earlyBirdsPeriodDays(h1, "2026-08-04"),
      ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"],
      "a mid-period preview must stop at today, or every remaining day counts as a day the rep failed to submit",
    );
    assert.equal(earlyBirdsPeriodDays(earlyBirdsPeriodFromKey("2026-02-H2")).length, 13, "16th-28th inclusive");
  }
}
