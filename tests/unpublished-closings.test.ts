import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The real selector, driven directly — it is pure precisely so this test needs no clock and no
// database. Same split, same reason, as scripts/branch-pr-state.mjs and scripts/needs-you.mjs.
import {
  NEEDS_YOU_CLOSING_FLOOR_PERIOD,
  normalizeClosingLine,
  selectUnpublishedClosings,
} from "../src/lib/sales/monthly-closing-publication.ts";

/**
 * Which finished months are not fully published — and, far more importantly, which months must
 * NEVER appear on that list.
 *
 * WHY THIS EXISTS. `src/lib/needs-you/` puts outstanding work in front of the owner so he can stop
 * checking for himself. A closing that is genuinely unpublished belongs there. A closing that is
 * already settled does not, and the two are one keystroke apart:
 *
 *   listAllPublishedClosings()    filters `.is("unpublished_at", null)`  -> WRONG to subtract
 *   listEverPublishedClosingKeys()  no filter at all                     -> the one to subtract
 *
 * Subtract the first and **August 2026 comes back** — published, announced to twelve people, later
 * withdrawn — as a month that still needs publishing. AGENTS.md §4: a published and announced month
 * is NEVER corrected, however justified the fix. Putting it back in front of him as outstanding
 * work invites exactly the correction that rule forbids, and it does so on the one screen built to
 * be trusted without checking.
 *
 * The clock assertions are not padding either. `isClosingPeriodComplete` resolves in Cairo, and a
 * UTC reading of the month boundary puts a brand-new month on the board three hours early on the
 * 1st — the same three-hour window `closing-period-gate.ts` and `home-snapshot.ts` each record
 * having been bitten by.
 */
export function runUnpublishedClosingsTests() {
  const LINES = ["CNS", "Anti Infective", "Pedia"];
  // The set the selector subtracts is built from the `normalized_line` COLUMN, so its keys are
  // normalized. Building them raw here would make every lookup miss and every month read as
  // unpublished — a test that passes for the wrong reason in the one direction that matters.
  const key = (line: string, period: string) => `${normalizeClosingLine(line)}|${period}`;

  // Mid-morning Cairo on 2026-09-28: August is finished, September is still running.
  const NOW = new Date("2026-09-28T07:00:00Z");

  // ── 1. The August 2026 trap — the most expensive defect this file can have ──
  // August published on every line, then WITHDRAWN on Anti Infective. `unpublished_at` is set, so
  // listAllPublishedClosings would omit it and the naive complement would call it outstanding.
  // `listEverPublishedClosingKeys` includes it, so it stays off the board.
  const everPublished = new Set(LINES.map((line) => key(line, "2026-08")));
  const settled = selectUnpublishedClosings({
    lines: LINES,
    periodsWithData: ["2026-08", "2026-09"],
    everPublished,
    now: NOW,
  });
  assert.deepEqual(
    settled,
    [],
    "August 2026 was published on every line — one of them later withdrawn — and it came back as a " +
      "month that still needs publishing. That is a published and announced month being offered for " +
      "correction, which AGENTS.md §4 forbids outright. The subtraction must be listEverPublishedClosingKeys " +
      "(no unpublished_at filter), never listAllPublishedClosings.",
  );

  // ── 2. A genuinely unpublished line IS reported, per period, with both halves named ──
  const partial = selectUnpublishedClosings({
    lines: LINES,
    periodsWithData: ["2026-08"],
    everPublished: new Set([key("CNS", "2026-08"), key("Pedia", "2026-08")]),
    now: NOW,
  });
  assert.equal(partial.length, 1, "one finished month with an unpublished line is one row");
  assert.equal(partial[0].period, "2026-08");
  assert.deepEqual(
    partial[0].unpublishedLines,
    ["Anti Infective"],
    "the line is reported with the casing it was given. normalizeClosingLine lower-cases, and matching " +
      "and displaying with the same string prints \"anti infective\" on a board whose whole job is to be " +
      "read at a glance — normalize for the LOOKUP, never for the output.",
  );
  assert.deepEqual(
    partial[0].publishedLines,
    ["CNS", "Pedia"],
    "the published half is named too — a row reading only \"Anti Infective is not published\" makes " +
      "him open the screen to learn whether the other two were, which is the lookup this board removes",
  );
  assert.equal(partial[0].opensOn, "2026-09-01", "August could be published from 1 September, Cairo");

  // ── 3. The running month is not outstanding work ────────────────────────────
  // September has data and nothing published, and it must STILL be absent: a month that has not
  // finished has no closing at all. This is the closing golden rule holding by construction.
  const running = selectUnpublishedClosings({
    lines: LINES,
    periodsWithData: ["2026-09"],
    everPublished: new Set(),
    now: NOW,
  });
  assert.deepEqual(
    running,
    [],
    "the RUNNING month was listed as needing publication. A closing may not even be released during " +
      "the month it covers (closing-period-gate.ts), so offering it as outstanding work is asking " +
      "him to break the golden rule.",
  );

  // ── 4. The Cairo month boundary, both sides ─────────────────────────────────
  // Egypt is UTC+3 on these dates, so 2026-09-30T20:00Z is 23:00 on the 30th — still September.
  const lastHourOfSeptember = selectUnpublishedClosings({
    lines: ["CNS"],
    periodsWithData: ["2026-09"],
    everPublished: new Set(),
    now: new Date("2026-09-30T20:00:00Z"),
  });
  assert.deepEqual(
    lastHourOfSeptember,
    [],
    "23:00 Cairo on 30 September is still September — reading the boundary in UTC would open the " +
      "month three hours early",
  );

  // 2026-09-30T22:30Z is 01:30 on 1 October Cairo — September is now finished.
  const firstHourOfOctober = selectUnpublishedClosings({
    lines: ["CNS"],
    periodsWithData: ["2026-09"],
    everPublished: new Set(),
    now: new Date("2026-09-30T22:30:00Z"),
  });
  assert.equal(
    firstHourOfOctober.length,
    1,
    "01:30 Cairo on 1 October: September has finished and an unpublished September is real work",
  );
  assert.equal(firstHourOfOctober[0].period, "2026-09");

  // ── 5. A month nobody imported is not work ──────────────────────────────────
  const noData = selectUnpublishedClosings({
    lines: LINES,
    periodsWithData: [],
    everPublished: new Set(),
    now: NOW,
  });
  assert.deepEqual(
    noData,
    [],
    "with no validated import batch there is nothing to close. Without this the board would print " +
      "every month since the data began as outstanding work.",
  );

  // Newest month first — the board reads top-down and the freshest decision is the live one.
  // Every period here sits at or above the floor; the floor's own cases are section 5b.
  const ordered = selectUnpublishedClosings({
    lines: ["CNS"],
    periodsWithData: ["2026-07", "2026-09", "2026-08"],
    everPublished: new Set(),
    now: new Date("2026-10-15T09:00:00Z"),
  });
  assert.deepEqual(ordered.map((row) => row.period), ["2026-09", "2026-08", "2026-07"]);

  // ── 5b. Below the floor is a different exercise, not a backlog ──────────────
  //
  // 🔴 Owner's decision, 2026-09-28, taken from the board's first real run. January to June 2026
  // carry validated import batches but have NO publication row at all, so they arrived as six
  // permanently outstanding months — the oldest 240 days — sitting above every row that genuinely
  // needed him. They are reconciled per customer × product and revalued at the CURRENT price; that
  // exercise was never going to end in a publish.
  const belowFloor = selectUnpublishedClosings({
    lines: LINES,
    periodsWithData: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    everPublished: new Set(),
    now: new Date("2026-10-15T09:00:00Z"),
  });
  assert.deepEqual(
    belowFloor,
    [],
    "no period before the floor may be called outstanding work. Six never-publishable months at the " +
      "top of the board is how a board that is technically correct becomes one nobody reads.",
  );

  const straddling = selectUnpublishedClosings({
    lines: ["CNS"],
    periodsWithData: ["2026-05", "2026-06", "2026-07", "2026-08"],
    everPublished: new Set(),
    now: new Date("2026-10-15T09:00:00Z"),
  });
  assert.deepEqual(
    straddling.map((row) => row.period),
    ["2026-08", "2026-07"],
    "the floor includes itself and excludes everything below it",
  );

  assert.equal(
    NEEDS_YOU_CLOSING_FLOOR_PERIOD,
    "2026-07",
    "the floor is a FIXED date, and that is the mechanism. Deriving it from the earliest published " +
      "period is the obvious-looking improvement and is wrong: withdrawing July would move the floor " +
      "and bring all six pre-July months back, so the board's contents would depend on an unrelated " +
      "visibility toggle. Every dated rule in this repository works this way, for this reason.",
  );

  // ── 6. The two source rules that cannot be driven ───────────────────────────
  const source = readFileSync("src/lib/sales/monthly-closing-publication.ts", "utf8");
  const start = source.indexOf("export async function listUnpublishedClosings");
  assert.ok(start > 0, "listUnpublishedClosings not found");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  assert.match(
    body,
    /listEverPublishedClosingKeys\(\)/,
    "listUnpublishedClosings must subtract the EVER-published set. Subtracting listAllPublishedClosings " +
      "resurrects every withdrawn month as outstanding work — see assertion 1.",
  );
  assert.doesNotMatch(
    body,
    /listAllPublishedClosings/,
    "listUnpublishedClosings reaches for listAllPublishedClosings, which filters unpublished_at is null.",
  );
  assert.doesNotMatch(
    body,
    // No `s` (dotAll) flag: this repo's tsconfig target is below es2018, so it is a TS1501 build
    // error rather than a runtime one — and a local typecheck is denied here (bash-guard C8), so CI
    // is where it surfaces. The class `[^}]*` already spans newlines, so the flag bought nothing.
    /catch\s*\{[^}]*return\s*\[\]/,
    "listUnpublishedClosings swallows its error into an empty array. Everywhere else in this file `[]` " +
      "means \"treat as unpublished, leak no draft\"; here it means \"every month is published, nothing " +
      "needs you\" — the opposite direction, and the exact under-report this module exists to prevent. " +
      "It must throw so the board renders the source as unavailable.",
  );
  assert.match(
    body,
    /listMonthlyClosingLines\(\)/,
    "lines must come from listMonthlyClosingLines() with NO argument — selectClosingLines is what drops " +
      "Head Office, and taking the lines from anywhere else puts a line that is never closed on the board.",
  );
  assert.match(
    body,
    /listMonthlyClosingPeriods\(\)/,
    "periods must come from the validated-import-batch list, or a month nobody imported reads as work",
  );
}
