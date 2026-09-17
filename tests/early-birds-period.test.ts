import assert from "node:assert/strict";

import {
  EARLY_BIRDS_FIRST_PERIOD_KEY,
  EARLY_BIRDS_PERIOD_KEY_PATTERN,
  daysInMonth,
  earlyBirdsPeriodDays,
  earlyBirdsPeriodForDate,
  earlyBirdsPeriodFromKey,
  isEarlyBirdsPeriodClosed,
  isEarlyBirdsPeriodKey,
  isEarlyBirdsPeriodSelectable,
  listRecentEarlyBirdsPeriods,
  listSelectableEarlyBirdsPeriods,
  nextEarlyBirdsPeriod,
  previousEarlyBirdsPeriod,
  resolveEarlyBirdsPeriodParam,
} from "../src/lib/early-birds/period.ts";
import { formatFortnightHeading } from "../src/components/early-birds/early-birds-format.ts";

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

  // ── Which fortnights a viewer may ASK for ───────────────────────────────────────
  // The ?period= parameter was honoured by both pages from the day the module shipped, but nothing
  // ever set it, so every viewer was pinned to the live fortnight. Adding the picker (2026-09-18)
  // means a string off a URL now chooses which fortnight is scored, and it has to be bounded at
  // BOTH ends for a reason that is the same reason in both directions: an empty ranking looks
  // exactly like a real ranking of nobody.
  {
    const TODAY = "2026-09-18"; // inside September's second half

    assert.equal(
      EARLY_BIRDS_FIRST_PERIOD_KEY,
      "2026-08-H1",
      "the module's first fortnight is pinned. Moving it earlier offers a picker that reaches " +
        "back into fortnights with no snapshot behind them, and every one of them renders an " +
        "empty board that reads as a real result of zero.",
    );

    assert.equal(isEarlyBirdsPeriodSelectable("2026-09-H2", TODAY), true, "the live fortnight");
    assert.equal(isEarlyBirdsPeriodSelectable("2026-08-H1", TODAY), true, "the module's first");
    assert.equal(
      isEarlyBirdsPeriodSelectable("2026-07-H2", TODAY),
      false,
      "before the module existed - there is no snapshot, so there is nothing to show",
    );
    assert.equal(
      isEarlyBirdsPeriodSelectable("2026-10-H1", TODAY),
      false,
      "the future. A fortnight that has not started has no visits in it, and the board would " +
        "render 'days left' against work nobody has done yet",
    );
    assert.equal(isEarlyBirdsPeriodSelectable("2026-13-H1", TODAY), false, "not a real key");
    assert.equal(isEarlyBirdsPeriodSelectable("august", TODAY), false, "not a key at all");
  }

  // ── The picker's list ───────────────────────────────────────────────────────────
  {
    const TODAY = "2026-09-18";
    const periods = listSelectableEarlyBirdsPeriods(TODAY, 12);

    assert.deepEqual(
      periods.map((period) => period.periodKey),
      ["2026-09-H2", "2026-09-H1", "2026-08-H2", "2026-08-H1"],
      "newest first, and STOPPING at the module's first fortnight rather than running twelve deep " +
        "into fortnights that never had a board",
    );

    // The switcher walks this array for its prev/next arrows and reads periods[i + 1] as OLDER.
    // If the order ever flipped, both arrows would silently point the wrong way.
    for (let index = 1; index < periods.length; index += 1) {
      assert.ok(
        periods[index].periodKey < periods[index - 1].periodKey,
        `listSelectableEarlyBirdsPeriods must run newest -> oldest; ${periods[index].periodKey} ` +
          `follows ${periods[index - 1].periodKey}`,
      );
    }

    assert.deepEqual(listSelectableEarlyBirdsPeriods(TODAY, 0), [], "a zero count asks for nothing");
    assert.equal(
      listSelectableEarlyBirdsPeriods("2026-08-03", 12).length,
      1,
      "in the module's very first fortnight the picker offers exactly that one",
    );
  }

  // ── A bad ?period= CLAMPS, where a bad ?district= REFUSES ───────────────────────
  // Deliberately different from assertDistrictInScope, and the difference is not arbitrary. Every
  // surface names the fortnight it is showing - the switcher marks the active chip, and the board
  // header names it too (see the heading block below) - so a clamp is VISIBLE. A district substitution
  // would show one manager another manager's reps under a heading he has no reason to doubt.
  {
    const TODAY = "2026-09-18";
    assert.equal(resolveEarlyBirdsPeriodParam("2026-08-H1", TODAY).periodKey, "2026-08-H1");
    assert.equal(resolveEarlyBirdsPeriodParam(undefined, TODAY).periodKey, "2026-09-H2", "no param = live");
    assert.equal(resolveEarlyBirdsPeriodParam(null, TODAY).periodKey, "2026-09-H2");
    assert.equal(resolveEarlyBirdsPeriodParam("", TODAY).periodKey, "2026-09-H2");
    assert.equal(resolveEarlyBirdsPeriodParam("nonsense", TODAY).periodKey, "2026-09-H2", "malformed clamps");
    assert.equal(resolveEarlyBirdsPeriodParam("2030-01-H1", TODAY).periodKey, "2026-09-H2", "the future clamps");
    assert.equal(resolveEarlyBirdsPeriodParam("2019-01-H1", TODAY).periodKey, "2026-09-H2", "pre-module clamps");
  }

  // ── The board heading never calls a CLOSED fortnight "this" one ─────────────────
  // The period picker is what makes a closed fortnight reachable at all, so this claim is only
  // newly falsifiable. A manager reading August in September must not be told August is the
  // fortnight he is in. The label itself is present either way - a heading that named no
  // fortnight would be worse than one that named it wrongly, because nothing would contradict it.
  {
    const LABEL = "August 1-15, 2026";
    assert.equal(
      formatFortnightHeading(LABEL, true),
      "Fortnight · August 1-15, 2026",
      "a closed fortnight is named, and never called \"this\" fortnight",
    );
    assert.equal(
      formatFortnightHeading("September 16-30, 2026", false),
      "This fortnight · September 16-30, 2026",
      "the live fortnight keeps the present tense",
    );
    assert.ok(
      formatFortnightHeading(LABEL, true).includes(LABEL),
      "the fortnight is named whether or not it is closed",
    );
  }
}
