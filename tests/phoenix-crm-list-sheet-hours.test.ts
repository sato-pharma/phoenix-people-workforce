import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  foldHoursCell,
  parseHourToken,
  parseListSheetHours,
  weekdayOfToken,
} from "../src/lib/phoenix-crm/list-sheet-hours.ts";
import { parseTimings, weekTimingsText } from "../src/lib/phoenix-crm/timings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the clinic's days and hours, read out of ONE spreadsheet cell.
 *
 * Owner's instruction, 2026-10-05: *"put the clinic days and hours in the SFE's list-template sheet."*
 * The field audit counted 1,238 presses of the timings editor's weekday buttons against 554 presses that
 * recorded a call: the rep was typing about three day-and-hour rows per customer, at the door, across a
 * list of about 670 names. The sheet carries them once instead.
 *
 * What this pins, and why each one would otherwise go wrong quietly:
 *
 *   (a) The cell is FREE TEXT and the rules are forgiving, but an unreadable cell returns null and never
 *       refuses the row — exactly the owner's ruling about the grade and the potential on this same
 *       sheet. A sheet that refuses 170 rows over a time column costs more than the column saves.
 *   (b) A MARKER-LESS RANGE keeps both ends in the same half of the day. Read end-by-end, "5-8" came out
 *       17:00 → 08:00 and `parseTimings` then refused the whole cell, so the commonest way to write a
 *       clinic's evening silently became no hours at all.
 *   (c) THE ARABIC "AND" IS GLUED TO THE DAY. "السبت والاثنين" is two days written as two words, the
 *       second being `والاثنين`; no word-boundary split separates them, so splitting on `\bو` found
 *       Saturday and dropped Monday without a word.
 *   (d) `parseTimings` IS THE ONLY AUTHORITY on what a valid set is. No second opinion lives here, or
 *       the sheet and the door come to disagree about the same clinic.
 *   (e) IT CANNOT WRITE A PLACE. The frozen-place rule is about a POSITION; this file must never grow a
 *       latitude, a brick or an address, and it must never be "fixed" back by deleting the column.
 */

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

/**
 * Every window a cell names, as `weekday:start-end`, SORTED.
 *
 * Ordered by weekday then start, on purpose: the module's own `sortTimings` puts SATURDAY first, and
 * which day leads is pinned where that order matters. This file is about what the cell SAYS, so it
 * compares the set in a fixed order of its own.
 */
function windows(cell: string): string[] {
  const timings = parseListSheetHours(cell);
  if (!timings) return [];
  return [...timings]
    .sort((left, right) => left.weekday - right.weekday || left.startMinute - right.startMinute)
    .map((timing) => `${timing.weekday}:${timing.startMinute}-${timing.endMinute ?? "open"}`);
}

// ── The folding, which every match runs through ──────────────────────────────────────────────────
function checkFolding(): void {
  // A phone keyboard produces Arabic-Indic digits and ExcelJS hands them straight through; unfolded,
  // "٥:٠٠" reads as no time at all.
  assert.equal(foldHoursCell("٥:٣٠ م"), "5:30 م", "Arabic-Indic digits become ASCII");
  assert.equal(foldHoursCell("۵:۳۰"), "5:30", "and so do the Persian forms a keyboard can emit");
  assert.equal(foldHoursCell("الإثنين"), "الاثنين", "alif variants are one letter");
  assert.equal(foldHoursCell("5 – 8"), "5 - 8", "an en dash is a hyphen");
  assert.equal(foldHoursCell("5 — 8"), "5 - 8", "and so is an em dash — Excel's autocorrect makes both");
  assert.equal(foldHoursCell("Sat، Mon"), "sat, mon", "the Arabic comma separates segments like a plain one");
  assert.equal(foldHoursCell("  Sat   5:00   PM "), "sat 5:00 pm", "runs of space collapse");
  assert.equal(foldHoursCell(null), "", "and a cell nobody filled folds to nothing");
}

// ── One clock reading ────────────────────────────────────────────────────────────────────────────
function checkHourToken(): void {
  assert.equal(parseHourToken("17:00", null), 17 * 60, "a 24-hour time is taken as written");
  assert.equal(parseHourToken("5:30 pm", null), 17 * 60 + 30, "an explicit PM is honoured");
  assert.equal(parseHourToken("12 am", null), 0, "midnight is 00:00, not 12:00");
  assert.equal(parseHourToken("12 pm", null), 12 * 60, "and noon is 12:00, not 24:00");
  assert.equal(parseHourToken("5:00 م", null), 17 * 60, "the Arabic م is PM");
  assert.equal(parseHourToken("9 ص", null), 9 * 60, "and the Arabic ص is AM");
  assert.equal(parseHourToken("5", "pm"), 17 * 60, "a marker found elsewhere in the window reaches both ends");

  // 🔴 The owner's own example is "Saturday 2 to 4", which is the afternoon and not the middle of the
  // night. 8 to 12 are left alone because a hospital round at 8:00 AM is real.
  assert.equal(parseHourToken("2", null), 14 * 60, "a bare 2 is the afternoon");
  assert.equal(parseHourToken("7", null), 19 * 60, "and so is a bare 7");
  assert.equal(parseHourToken("8", null), 8 * 60, "a bare 8 is the morning round, untouched");
  assert.equal(parseHourToken("11", null), 11 * 60, "and a bare 11 stays in the morning");
  assert.equal(parseHourToken("2", "keep-as-written"), 2 * 60, "and the rule can be switched off, which only the range end needs");

  assert.equal(parseHourToken("24:00", null), 0, "24:00 is midnight at the end of the day");
  assert.equal(parseHourToken("13 pm", null), null, "13 PM is not a time");
  assert.equal(parseHourToken("25:00", null), null, "nor is a 25th hour");
  assert.equal(parseHourToken("5:75", null), null, "nor a 75th minute");
  assert.equal(parseHourToken("evening", null), null, "and a word is not a clock reading");
}

// ── The weekday, in both languages ───────────────────────────────────────────────────────────────
function checkWeekday(): void {
  assert.equal(weekdayOfToken("Saturday"), DAYS.Sat, "the full English name");
  assert.equal(weekdayOfToken("sat"), DAYS.Sat, "its short form, folded");
  assert.equal(weekdayOfToken("Tue."), DAYS.Tue, "with the full stop a rep types");
  assert.equal(weekdayOfToken("السبت"), DAYS.Sat, "the Arabic name");
  assert.equal(weekdayOfToken("اتنين"), DAYS.Mon, "the spoken Arabic spelling, without the article");
  assert.equal(weekdayOfToken("الإثنين"), DAYS.Mon, "and the hamza'd one, which folds to the same token");

  // 🔴 (c) — Arabic joins the conjunction to the noun. This is the assertion that was red.
  assert.equal(weekdayOfToken("والاثنين"), DAYS.Mon, "a day with the Arabic 'and' glued to its front is still that day");
  assert.equal(weekdayOfToken("و"), null, "but a lone conjunction names no day");
  assert.equal(weekdayOfToken("whenever"), null, "and neither does a word that is not one");
}

// ── Whole cells, the way they are actually written ───────────────────────────────────────────────
function checkCells(): void {
  assert.deepEqual(windows("Sat 5:00 PM - 8:00 PM"), ["6:1020-1200"], "the format the sheet asks for");
  assert.deepEqual(windows("Saturday 17:00-20:00"), ["6:1020-1200"], "and the 24-hour one");
  assert.deepEqual(
    windows("Sat 5:00 PM - 8:00 PM, Mon 6:00 PM"),
    ["1:1080-open", "6:1020-1200"],
    "two days, one with an open-ended window — the sheet's own hint, read back",
  );

  // Days sharing one window, which is how the rep's own editor works: tick the days, write the hour once.
  assert.deepEqual(
    windows("Sat, Mon, Tue 17:00-20:00"),
    ["1:1020-1200", "2:1020-1200", "6:1020-1200"],
    "a segment naming days and no time takes the window of the next segment that has one",
  );

  // 🔴 (b) — the range keeps both ends in one half of the day.
  assert.deepEqual(windows("Sat 5-8"), ["6:1020-1200"], "a marker-less 5-8 is the evening, not 17:00 to 08:00");
  assert.deepEqual(windows("Sat 6-9"), ["6:1080-1260"], "and 6-9 likewise");
  assert.deepEqual(windows("Sat 11-2"), ["6:660-840"], "while 11-2 straddles noon as written, 11:00 to 14:00");
  assert.deepEqual(windows("Sat 2-4"), ["6:840-960"], "and the owner's own \"Saturday 2 to 4\" is the afternoon");
  assert.deepEqual(windows("Sat 10 to 12"), ["6:600-720"], "\"to\" reads as a range, not two lone times");

  // The late clinic: an end before its start rolls into the next morning, which is what the module's
  // own `resolveEndMinute` does. Forcing the range into one half of the day would have lost this.
  assert.deepEqual(windows("Sat 22:00 - 1:00"), ["6:1320-1500"], "a clinic closing at 1:00 AM survives");

  // 🔴 AN END THAT SAYS ITS OWN AM OR PM IS TAKEN AT ITS WORD, even where shifting it half a day would
  // have landed it neatly after the start. Here the placing rule would read 2:00 AM as 2:00 PM and turn
  // a long evening into one hour; the written marker wins and the window crosses midnight instead.
  assert.deepEqual(windows("Sat 1:00 PM - 2:00 AM"), ["6:780-1560"], "an explicit AM on the end is not shifted into the afternoon");
  assert.deepEqual(windows("Sat 9:00 AM - 12:00 PM"), ["6:540-720"], "and an explicit PM on the end is noon, not midnight");

  // Arabic, the way a rep writes it.
  assert.deepEqual(windows("السبت والاثنين 5-8 م"), ["1:1020-1200", "6:1020-1200"], "two Arabic days sharing one evening");
  assert.deepEqual(windows("الخميس ٩:٠٠ ص - ١٢:٠٠"), ["4:540-720"], "Arabic digits and an Arabic AM");

  // Two sittings in a day, written as the second segment with no day of its own.
  assert.deepEqual(windows("Sat 10-12, 5-8"), ["6:600-720", "6:1020-1200"], "hours with no day belong to the day last named");

  // A slip, not an overlap the SFE should be told about — and `parseTimings` would refuse the whole
  // cell for "the same time twice", which would cost the row its hours over a double paste.
  assert.deepEqual(windows("Sat 5-8, Saturday 5-8"), ["6:1020-1200"], "the same day and window twice is one window");

  // 🔴 (a) — null is the ordinary answer, and it is the SAME answer for empty and for unreadable.
  assert.equal(parseListSheetHours(""), null, "an empty cell");
  assert.equal(parseListSheetHours("   "), null, "a cell holding only space");
  assert.equal(parseListSheetHours(null), null, "a cell nobody filled");
  assert.equal(parseListSheetHours("ask the rep"), null, "a sentence with no time in it");
  assert.equal(parseListSheetHours("Sat"), null, "a day with no hour at all");
  assert.equal(parseListSheetHours("Daily 5-8"), null, '"Daily" names no weekday this can resolve, so it reads as nothing');
  assert.equal(parseListSheetHours(42), null, "and a number Excel turned a time into is not read as a clinic's evening");
}

// ── `parseTimings` is the only authority ─────────────────────────────────────────────────────────
function checkOneAuthority(): void {
  // Everything this returns is something the rep's own phone and the server would both accept.
  for (const cell of ["Sat 5:00 PM - 8:00 PM", "Sat, Mon, Tue 17:00-20:00", "السبت والاثنين 5-8 م", "Sat 10-12, 5-8"]) {
    const timings = parseListSheetHours(cell);
    assert.ok(timings, `${cell} reads`);
    if (!timings) continue;
    const rechecked = parseTimings(
      timings.map((timing) => ({
        end: timing.endMinute === null ? "" : `${String(Math.floor(timing.endMinute / 60) % 24).padStart(2, "0")}:${String(timing.endMinute % 60).padStart(2, "0")}`,
        season: timing.season,
        start: `${String(Math.floor(timing.startMinute / 60)).padStart(2, "0")}:${String(timing.startMinute % 60).padStart(2, "0")}`,
        weekday: timing.weekday,
      })),
    );
    assert.equal(rechecked.ok, true, `and ${cell} is still valid to the module's own parser: ${rechecked.ok ? "" : rechecked.error}`);
  }

  // A cell the module's rules refuse comes back null rather than half-read: five windows in one day is
  // over the limit `parseTimings` sets, and this file must not invent a looser one of its own.
  assert.equal(parseListSheetHours("Sat 8-9, 10-11, 12-13, 14-15, 16-17"), null, "a cell the module's own parser refuses reads as nothing");

  const source = stripComments(readFileSync("src/lib/phoenix-crm/list-sheet-hours.ts", "utf8"));
  assert.match(source, /parseTimings\(/, "the parser hands its reading to parseTimings");
  for (const invented of ["TIMING_WINDOWS_MAX", "MAX_WINDOWS", "overlap", "TOO_LONG"]) {
    assert.ok(!source.includes(invented), `and holds no second opinion of its own about ${invented}`);
  }

  // 🔴 (e) — it reads hours out of a cell, and it can never read a position out of one.
  //
  // Matched on WORD boundaries, not as substrings: the first spelling of this assertion read `lat` and
  // `lon` as substrings and fired on the parser's own `later` and `lonePattern`, which is a red test
  // over nothing and the fastest way to get an assertion deleted rather than fixed.
  for (const forbidden of [/\blat\b/i, /latitude/i, /\blon\b/i, /longitude/i, /brick/i, /address/i, /area_?code/i, /\bregion/i, /photo/i, /accuracy/i]) {
    assert.ok(
      !forbidden.test(source),
      `the hours parser must never learn about ${forbidden} — a place's position is captured at the door, never typed`,
    );
  }
}

// ── What the sheet PRINTS is what the sheet READS ─────────────────────────────────────────────────
function checkRoundTrip(): void {
  // The download prints a customer's known hours with `weekTimingsText`, and an SFE who leaves that cell
  // alone must upload the same hours back. If these two ever drift, re-uploading an untouched sheet
  // quietly rewrites every clinic's evening — and nothing else in the system would notice.
  for (const cell of ["Sat 5:00 PM - 8:00 PM, Mon 6:00 PM", "Sat, Mon, Tue 17:00-20:00", "Sat 10-12, 5-8", "Sat 22:00 - 1:00"]) {
    const first = parseListSheetHours(cell);
    assert.ok(first, `${cell} reads`);
    if (!first) continue;
    const printed = weekTimingsText(first, false);
    assert.deepEqual(
      parseListSheetHours(printed),
      first,
      `what the sheet prints for "${cell}" (${printed}) reads back as the same hours`,
    );
  }
}

export function runPhoenixCrmListSheetHoursTests() {
  checkFolding();
  checkHourToken();
  checkWeekday();
  checkCells();
  checkOneAuthority();
  checkRoundTrip();
}
