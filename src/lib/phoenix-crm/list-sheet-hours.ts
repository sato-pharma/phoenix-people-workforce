/**
 * Phoenix CRM — reading the days and hours a customer receives out of ONE spreadsheet cell.
 *
 * Owner's instruction, 2026-10-05, after the first field audit: *"put the clinic days and hours in the
 * SFE's list-template sheet."*
 *
 * ## Why this exists — the measured reason
 *
 * The audit of the module's first three live days (`docs/phoenix-crm-field-audit-2026-10-05.md`) counted
 * what the reps' fingers actually did. Against **554** presses that recorded a call there were **3,728**
 * presses of registration, and **1,238 of those were the weekday buttons** of the timings editor: a rep
 * types about 3 day-and-hour rows per customer, by hand, at the door, for every customer on a list that
 * runs to about 670 names. Validating the carried-over lists at that rate takes roughly fifteen more
 * weeks. Whoever knows the clinic's hours can write them once in the sheet instead, and the rep then
 * CONFIRMS them in two taps rather than building them from nothing.
 *
 * ## 🔴 THIS IS NOT A TYPED PLACE, AND IT DOES NOT TOUCH THE FROZEN-PLACE RULE
 *
 * A place's LOCATION is captured at the door, once, from a live signboard photo and a GPS read, and its
 * address, brick, area and region are resolved server-side from that point. That rule (owner,
 * 2026-09-23/29) is about the POSITION, and a latitude in a spreadsheet is what it forbids. Days and
 * hours are not a position: they are already typed by hand, by the rep, into a plain form, and nothing
 * in the system measures them against anything. So the sheet may carry them — and the next person to
 * read this file must not "fix" that back by removing the column, because the two rules are about
 * different things. What the sheet carries is a DRAFT: it lands on the customer, it is shown to the rep
 * pre-filled when he validates, and what is STORED on the place is whatever he confirms. The sheet can
 * never write a place.
 *
 * ## 🔴 A CELL THIS CANNOT READ NEVER REFUSES THE ROW
 *
 * Exactly the owner's ruling about the grade and the potential on this same sheet (2026-10-03: *"make the
 * grade and the potential optional, not required"*, and on a grade typed where it does not belong,
 * *"ignore it, let them load"*). An unreadable cell is dropped to null and the customer still loads; the
 * rep then types his hours at the door as he does today. The failure direction matters: a sheet that
 * refuses 170 rows over a free-text time column would cost more than the column saves.
 *
 * ## What a cell may say
 *
 * The cell is free text, because a rep fills this sheet and he writes the way he speaks. All of these
 * read:
 *
 *     Sat 5:00 PM - 8:00 PM, Mon 6:00 PM
 *     Saturday 17:00-20:00; Monday 18:00
 *     Sat, Mon, Tue 17:00-20:00          ← days sharing one window, which is how his own editor works
 *     السبت والاثنين 5-8 م
 *     Sat 2-4
 *
 * Days may be English (full or short) or Arabic. Windows may be 24-hour, 12-hour with AM/PM, or Arabic
 * ص / م. A segment naming days with NO time inherits the window of the next segment that has one, which
 * is what "Sat, Mon, Tue 17:00-20:00" means to the person who wrote it.
 *
 * 🔴 **A BARE HOUR FROM 1 TO 7 IS READ AS THE AFTERNOON**, so the owner's own example — *"Saturday 2 to
 * 4"* — reads 2:00 PM to 4:00 PM and not the middle of the night. 8 to 12 are left as written, because a
 * hospital round at 8:00 AM is real. The sheet's own hint asks for 24-hour or an explicit AM/PM; this
 * rule is the forgiving fallback under it, and it is stated on the sheet so nobody is surprised by it.
 *
 * ## One authority on what a valid set of timings is
 *
 * Whatever this reads is handed to `parseTimings` — the very function the rep's phone and the server
 * both use — and kept only if that accepts it. There is deliberately no second opinion here about
 * overlaps, window length, windows per day or the past-midnight clinic: a second validator is how the
 * sheet and the door come to disagree about the same clinic.
 */

import { parseTimings, PHOENIX_CRM_WEEKDAY_NAMES, PHOENIX_CRM_WEEKDAY_SHORT } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/**
 * The Arabic weekday names, indexed 0 = Sunday … 6 = Saturday like everything else in the module.
 *
 * Written with and without the definite article, because a rep writes both. The forms are matched after
 * Arabic normalisation (below), so "الاثنين" and "الإثنين" are one token.
 */
const ARABIC_WEEKDAYS: readonly (readonly string[])[] = [
  ["الاحد", "احد"],
  ["الاثنين", "اثنين", "الاتنين", "اتنين"],
  ["الثلاثاء", "ثلاثاء", "التلات", "تلات", "الثلاث"],
  ["الاربعاء", "اربعاء", "الاربع", "اربع"],
  ["الخميس", "خميس"],
  ["الجمعة", "جمعة", "الجمعه", "جمعه"],
  ["السبت", "سبت"],
];

/** Arabic AM / PM: صباحا and مساء, in the short forms a rep actually writes. */
const ARABIC_AM = ["ص", "صباحا", "صباحاً", "صباح"];
const ARABIC_PM = ["م", "مساء", "مساءً", "مساءا", "ظهرا", "عصرا"];

const MINUTES_PER_HOUR = 60;

/**
 * One cell, folded for matching: Arabic digits turned into ASCII, Arabic letter variants unified, every
 * dash made a plain hyphen, whitespace collapsed, lower-cased.
 *
 * The Arabic-Indic digits matter because a phone keyboard produces them and ExcelJS hands them straight
 * through — "٥:٠٠" would otherwise read as no time at all.
 */
export function foldHoursCell(value: unknown): string {
  return String(value ?? "")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[آأإا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[‐-―−⁃﹘﹣－]/g, "-")
    .replace(/[،]/g, ",")
    .replace(/؛/g, ";")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Which weekday a token names, or null. English full, English short, or Arabic.
 *
 * 🔴 THE ARABIC "AND" IS GLUED TO THE WORD AND MUST BE STRIPPED HERE. "السبت والاثنين" is two days, but
 * the second word is written `والاثنين` — Arabic joins the conjunction to the noun, and no word-boundary
 * split can separate them, so splitting on `\bو` found one day and dropped the other silently. The
 * leading و is removed and the rest matched again, which is the only place that can be done because it
 * is the only place that knows whether what is left is a day at all.
 */
export function weekdayOfToken(token: string): number | null {
  const folded = foldHoursCell(token).replace(/\.$/, "");
  if (!folded) return null;
  const full = PHOENIX_CRM_WEEKDAY_NAMES.findIndex((name) => name.toLowerCase() === folded);
  if (full >= 0) return full;
  const short = PHOENIX_CRM_WEEKDAY_SHORT.findIndex((name) => name.toLowerCase() === folded);
  if (short >= 0) return short;
  const arabic = ARABIC_WEEKDAYS.findIndex((forms) => forms.includes(folded));
  if (arabic >= 0) return arabic;
  if (folded.startsWith("و") && folded.length > 1) {
    const withoutAnd = ARABIC_WEEKDAYS.findIndex((forms) => forms.includes(folded.slice(1)));
    if (withoutAnd >= 0) return withoutAnd;
  }
  return null;
}

/**
 * One clock reading out of a token such as "17:00", "5pm", "5", "5:30م" — minutes after midnight, or
 * null.
 *
 * `marker` carries an AM/PM found elsewhere in the same window ("5-8 PM" marks both ends), and a bare
 * hour of 1–7 with no marker anywhere is the afternoon — see the header. `"keep-as-written"` asks for
 * the reading with that afternoon rule switched OFF, which only `endAfterStart` needs.
 */
export function parseHourToken(token: string, marker: "am" | "pm" | null | "keep-as-written"): number | null {
  const folded = foldHoursCell(token);
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ص|م|صباحا|مساء)?$/.exec(folded);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(hours) || hours > 24 || minutes > 59) return null;
  const own = match[3] ?? null;
  const suffix: "am" | "pm" | null = own
    ? ARABIC_PM.includes(own) || own.startsWith("p")
      ? "pm"
      : ARABIC_AM.includes(own) || own.startsWith("a")
        ? "am"
        : null
    : null;
  const applied = suffix ?? (marker === "keep-as-written" ? null : marker);
  const afternoonRule = marker !== "keep-as-written";

  if (applied === "pm") {
    if (hours > 12) return null;
    hours = hours === 12 ? 12 : hours + 12;
  } else if (applied === "am") {
    if (hours > 12) return null;
    if (hours === 12) hours = 0;
  } else if (afternoonRule && hours >= 1 && hours <= 7) {
    // 🔴 The owner's own "Saturday 2 to 4" is the afternoon. 8–12 and 13–23 are left as written.
    hours += 12;
  }
  if (hours > 23) {
    // "24:00" is midnight at the end of the day; the timings parser folds the window itself.
    if (hours === 24 && minutes === 0) return 0;
    return null;
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

/** The AM/PM written anywhere in a window, which marks both of its ends. */
function markerIn(text: string): "am" | "pm" | null {
  const folded = foldHoursCell(text);
  if (/(^|[\s\d])(pm|p\.m\.|م|مساء|ظهرا|عصرا)(\s|$)/.test(folded)) return "pm";
  if (/(^|[\s\d])(am|a\.m\.|ص|صباحا|صباح)(\s|$)/.test(folded)) return "am";
  return null;
}

type Window = { start: string; end: string };

/** The am/pm a token carries ITSELF, as against one found elsewhere in the same window. */
function ownMarkerOf(token: string): "am" | "pm" | null {
  const folded = foldHoursCell(token);
  const match = /^\d{1,2}(?:[:.]\d{2})?\s*(am|pm|a\.m\.|p\.m\.|ص|م|صباحا|مساء)$/.exec(folded);
  if (!match) return null;
  const own = match[1]!;
  if (ARABIC_PM.includes(own) || own.startsWith("p")) return "pm";
  if (ARABIC_AM.includes(own) || own.startsWith("a")) return "am";
  return null;
}

/**
 * The end of a range, placed after its start.
 *
 * 🔴 AN END THAT SAYS ITS OWN AM OR PM IS TAKEN AT ITS WORD, whatever that does to the order. "10 PM -
 * 1 AM" is a real clinic and the 1:00 AM belongs to the next morning, which `resolveEndMinute` is
 * what handles. Only an end with NO marker of its own is placed, below.
 *
 * 🔴 AND THE HALF OF THE DAY IS THEN DECIDED FOR THE RANGE, NOT FOR EACH END ALONE. Read
 * independently, "5-8" came out 5:00 PM to 8:00 AM — the 5 bumped into the afternoon by the 1–7 rule
 * and the 8 left in the morning — and `parseTimings` then refused the whole cell as longer than a
 * clinic day, so one of the commonest ways to write a clinic's evening silently became no hours at all.
 * Three readings are tried in order and the first that lands AFTER the start wins:
 *
 *   (a) the plain reading — the window's own marker where there is one, else the afternoon rule, so
 *       "11-2" is 11:00 AM to 2:00 PM and "5-8 PM" is 5:00 PM to 8:00 PM;
 *   (b) that reading twelve hours later — "5-8" is 5:00 PM to 8:00 PM, and "9 ص - 12" is 9:00 AM to
 *       NOON rather than to midnight, which is what marking both ends alike used to make of it;
 *   (c) the hour exactly as written.
 *
 * 🔴 When none of them comes after the start, the AS-WRITTEN reading is returned on purpose, so
 * `resolveEndMinute` rolls it into the next morning: that is how the clinic closing at 1:00 AM is
 * entered ("22:00 - 1:00"), and forcing an order here would have thrown that case away.
 */
function endAfterStart(rawToken: string, startMinute: number, marker: "am" | "pm" | null): number | null {
  if (ownMarkerOf(rawToken) !== null) return parseHourToken(rawToken, null);
  const plain = marker === null ? parseHourToken(rawToken, null) : parseHourToken(rawToken, marker);
  const asWritten = parseHourToken(rawToken, "keep-as-written");
  const halfDayLater = plain === null || plain + 720 >= 1440 ? null : plain + 720;
  for (const candidate of [plain, halfDayLater, asWritten]) {
    if (candidate !== null && candidate > startMinute) return candidate;
  }
  return asWritten ?? plain;
}

/**
 * The windows named in one segment: "5:00 pm - 8:00 pm" is one, "5-8 and 9-10" is two.
 *
 * A range is read before a lone time, so the "8" of "5-8" is never also read as its own window.
 */
function windowsIn(segment: string): Window[] {
  const folded = foldHoursCell(segment);
  const marker = markerIn(folded);
  const windows: Window[] = [];
  const consumed: Array<[number, number]> = [];

  const rangePattern = /(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|ص|م|صباحا|مساء)?)\s*(?:-|to|الي|حتي|لـ|ل)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|ص|م|صباحا|مساء)?)/g;
  for (let found = rangePattern.exec(folded); found; found = rangePattern.exec(folded)) {
    const start = parseHourToken(found[1]!, marker);
    if (start === null) continue;
    const end = endAfterStart(found[2]!, start, marker);
    if (end === null) continue;
    windows.push({ end: clock(end), start: clock(start) });
    consumed.push([found.index, found.index + found[0]!.length]);
  }

  const lonePattern = /(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|ص|م|صباحا|مساء)?)/g;
  for (let found = lonePattern.exec(folded); found; found = lonePattern.exec(folded)) {
    const at = found.index;
    if (consumed.some(([from, to]) => at >= from && at < to)) continue;
    const start = parseHourToken(found[1]!, marker);
    if (start === null) continue;
    windows.push({ end: "", start: clock(start) });
  }
  return windows;
}

function clock(minute: number): string {
  const hours = Math.floor(minute / MINUTES_PER_HOUR);
  const minutes = minute % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The weekdays named in one segment, in the order written, each once. */
function daysIn(segment: string): number[] {
  const days: number[] = [];
  for (const token of foldHoursCell(segment).split(/[\s/&]+|\band\b|\bو/)) {
    const cleaned = token.replace(/[^\p{L}.]/gu, "");
    if (!cleaned) continue;
    const weekday = weekdayOfToken(cleaned);
    if (weekday !== null && !days.includes(weekday)) days.push(weekday);
  }
  return days;
}

/**
 * The cell, as timings — or null when there is nothing readable in it.
 *
 * 🔴 NULL IS THE ORDINARY ANSWER FOR A CELL NOBODY FILLED, and it is also the answer for a cell nobody
 * can read. The caller never distinguishes them, because the customer loads either way.
 */
export function parseListSheetHours(value: unknown): PhoenixCrmTiming[] | null {
  const folded = foldHoursCell(value);
  if (!folded) return null;

  const segments = folded
    .split(/[,;·|\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const parsed = segments.map((segment) => ({ days: daysIn(segment), windows: windowsIn(segment) }));

  // "Sat, Mon, Tue 17:00-20:00": a segment naming days and no time takes the window of the next
  // segment that has one. Read forward only — that is the order the sentence was written in.
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index]!;
    if (entry.days.length === 0 || entry.windows.length > 0) continue;
    const later = parsed.slice(index + 1).find((candidate) => candidate.windows.length > 0);
    if (later) entry.windows = later.windows;
  }

  // A segment with hours and no day of its own belongs to the days last named, so "Sat 10-12, 5-8"
  // gives Saturday two sittings.
  let lastDays: number[] = [];
  const drafts: Array<{ weekday: number; start: string; end: string; season: "normal" }> = [];
  for (const entry of parsed) {
    const days = entry.days.length > 0 ? entry.days : lastDays;
    if (entry.days.length > 0) lastDays = entry.days;
    if (days.length === 0 || entry.windows.length === 0) continue;
    for (const weekday of days) {
      for (const window of entry.windows) {
        drafts.push({ end: window.end, season: "normal", start: window.start, weekday });
      }
    }
  }
  if (drafts.length === 0) return null;

  // Two identical day-and-window pairs are one: "Sat 5-8, Saturday 5-8" is a slip, not an overlap the
  // SFE should be told about, and `parseTimings` would refuse the whole cell for "the same time twice".
  const unique = drafts.filter(
    (draft, index) =>
      drafts.findIndex((other) => other.weekday === draft.weekday && other.start === draft.start && other.end === draft.end) === index,
  );

  const checked = parseTimings(unique);
  return checked.ok ? checked.timings : null;
}
