// One occasion, several people — the rule about what may share a picture, and the words on it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. Five people reaching the same milestone on the same day used to mean five
// separate exports, one name at a time, and nothing that could be SENT as a single picture (the
// owner, 2026-09-30: "I have five employees that have the same milestone in one day … I want to
// make a photo that has them all"). The batch already prints them as one PDF, one card per page —
// that is a thing to print, not a thing to post. This module decides what a group picture may hold
// and what it says; `group-card.ts` draws it.
//
// 🔴 A GROUP PICTURE IS FOR ONE OCCASION, NEVER A MIXED TICK LIST. The seal, the eyebrow and the
// sentence all name one occasion; a picture carrying a five-year anniversary and a birthday would
// have to tell a half-truth in every one of the three. So a mixed set is REFUSED here, in words
// that name what was mixed, rather than silently taking the first row's occasion for everybody.
//
// 🔴 NO PRONOUNS AND NO AGE, exactly as on the single card. `employees.gender` is not something a
// keepsake should depend on being right, and a birthday counts birthdays AT SATO PHARMA, never an
// age (see `periods.ts`).
//
// Pure: no I/O, no rendering, no database. Everything here is a function of the ticked rows.

import {
  birthdayEyebrow,
  birthdayStripLabel,
  birthdayTileNumeral,
  birthdayTileUnit,
  comparePlainDates,
  formatMilestoneSpec,
  formatPlainDateIso,
  formatPlainDateLong,
  formatPlainDateWords,
  milestoneEyebrow,
  milestoneStripLabel,
  milestoneTileNumeral,
  milestoneTileUnit,
  monthName,
  monthNameShort,
  numberWords,
  parseMilestoneSpec,
  type MilestoneSpec,
  type PlainDate,
} from "./periods";

/** The most faces one picture holds. `group-card.ts` sizes its grid against exactly this number. */
export const MILESTONE_GROUP_MAX = 12;

/** The fewest. One person has their own card, which is a better card than a group of one. */
export const MILESTONE_GROUP_MIN = 2;

/**
 * What the whole picture is about.
 *
 * `service`         — everybody reaches the SAME service milestone (all `1y`, all `5y`).
 * `birthday`        — everybody marks the SAME birthday at Sato Pharma (all `b4`).
 * `sharedBirthday`  — birthdays of DIFFERENT ordinals that fall on ONE day. The commonest real
 *                     case of all, and the one a same-ordinal rule would have refused: five people
 *                     born on the 30th have five different tenures. Allowed only when the date is
 *                     shared, because "birthdays" with no one day behind them is not an occasion.
 */
export type MilestoneGroupOccasion =
  | { kind: "service"; spec: MilestoneSpec }
  | { kind: "birthday"; ordinal: number }
  | { kind: "sharedBirthday"; on: PlainDate };

export class MilestoneGroupOccasionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MilestoneGroupOccasionError";
  }
}

/** One ticked row, as far as this module is concerned. */
export type MilestoneGroupRow = {
  /** The canonical spec string — `1y`, `b4`. */
  periodSpec: string;
  /** The date that row celebrates. */
  on: PlainDate;
  /** For the refusal message, which names people rather than codes (AGENTS.md §4). */
  displayName: string;
};

const BIRTHDAY_SPEC = /^b(\d+)$/i;

/**
 * How many faces a picture may hold — checked BEFORE any photograph is fetched as well as inside
 * `resolveMilestoneGroupOccasion`, so a 40-name tick list is refused in milliseconds instead of
 * after forty portraits have been decoded. One message, one place.
 */
export function assertMilestoneGroupSize(count: number): void {
  if (count < MILESTONE_GROUP_MIN) {
    throw new MilestoneGroupOccasionError(
      "A group picture needs at least two people — tick the ones who share the occasion. One person on their own gets a better card of their own.",
    );
  }
  if (count > MILESTONE_GROUP_MAX) {
    throw new MilestoneGroupOccasionError(
      `A group picture holds at most ${MILESTONE_GROUP_MAX} faces — past that nobody on it is recognisable. Make two pictures.`,
    );
  }
}

/**
 * The occasion label a refusal message uses — "five years", "fourth birthday".
 *
 * Lower-cased, because it lands mid-sentence: the strip labels are capitalised for a table cell, and
 * "these rows are Fourth birthday and five years" reads as a bug in the sentence.
 */
export function milestoneGroupRowLabel(periodSpec: string): string {
  const birthday = BIRTHDAY_SPEC.exec(periodSpec.trim());
  const label = birthday
    ? birthdayStripLabel(Number(birthday[1]))
    : safeMilestoneLabel(periodSpec);
  return label.toLowerCase();
}

function safeMilestoneLabel(periodSpec: string): string {
  try {
    return milestoneStripLabel(parseMilestoneSpec(periodSpec));
  } catch {
    return periodSpec;
  }
}

/** Distinct values, in first-seen order — so a refusal lists occasions the way the rows do. */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** "five years and one year", "a birthday, five years and one month" — for the refusal. */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The one occasion these rows share, or a refusal that says exactly what is mixed.
 *
 * 🔴 IT NEVER PICKS THE FIRST ROW'S OCCASION FOR EVERYBODY. That is the whole point: taking row
 * one's seal and printing it over five faces is a picture that states something false about four
 * of them, and nothing on the sheet would show it.
 */
export function resolveMilestoneGroupOccasion(rows: readonly MilestoneGroupRow[]): MilestoneGroupOccasion {
  assertMilestoneGroupSize(rows.length);

  const specs = distinct(rows.map((row) => row.periodSpec.trim().toLowerCase()));
  const birthdays = specs.filter((spec) => BIRTHDAY_SPEC.test(spec));

  if (birthdays.length > 0 && birthdays.length !== specs.length) {
    throw new MilestoneGroupOccasionError(
      `A group picture is for one occasion, and these rows are ${listWords(
        distinct(rows.map((row) => milestoneGroupRowLabel(row.periodSpec))),
      )}. Tick one occasion at a time — a birthday and an anniversary cannot share one seal.`,
    );
  }

  // ── Every row is a birthday ───────────────────────────────────────────────────────────────────
  if (birthdays.length > 0) {
    if (specs.length === 1) {
      return { kind: "birthday", ordinal: Number(BIRTHDAY_SPEC.exec(specs[0])![1]) };
    }
    // Different birthdays at Sato Pharma. One DAY is what still makes it an occasion.
    const first = rows[0].on;
    if (rows.every((row) => comparePlainDates(row.on, first) === 0)) {
      return { kind: "sharedBirthday", on: first };
    }
    throw new MilestoneGroupOccasionError(
      "These birthdays are different birthdays at Sato Pharma on different days, so there is no one occasion to put on the seal. Tick the ones that fall on one day.",
    );
  }

  // ── Every row is a service milestone ──────────────────────────────────────────────────────────
  //
  // 🔴 COMPARED AS PARSED PERIODS, NOT AS STRINGS. `parseMilestoneSpec` reads a period the way the
  // owner types one, so "6 months", "6 month" and "6m" are the SAME milestone; comparing the raw
  // strings would refuse a set that plainly shares one occasion, and the refusal would be about
  // spelling rather than about anything on the sheet.
  const parsed = rows.map((row) => parseMilestoneSpec(row.periodSpec));
  if (distinct(parsed.map(formatMilestoneSpec)).length > 1) {
    throw new MilestoneGroupOccasionError(
      `A group picture is for one milestone, and these rows are ${listWords(
        distinct(rows.map((row) => milestoneGroupRowLabel(row.periodSpec))),
      )}. Tick one milestone at a time.`,
    );
  }
  return { kind: "service", spec: parsed[0] };
}

/** The commemorative seal — the numeral and the word under it. Upper-cased by the card, not here. */
export function milestoneGroupTile(occasion: MilestoneGroupOccasion): { numeral: string; unit: string } {
  if (occasion.kind === "service") {
    return { numeral: milestoneTileNumeral(occasion.spec), unit: milestoneTileUnit(occasion.spec) };
  }
  if (occasion.kind === "birthday") {
    return { numeral: birthdayTileNumeral(occasion.ordinal), unit: birthdayTileUnit() };
  }
  // Mixed ordinals on one day: the DAY is the only thing every face has in common, so the day is
  // what the seal carries. "SEP", never "SEPTEMBER" — the seal is 46pt wide.
  return {
    numeral: String(occasion.on.day).padStart(2, "0"),
    unit: monthNameShort(occasion.on.month),
  };
}

/** The tracked line over the date — "FIVE YEARS AT SATO PHARMA". Upper-cased by the card. */
export function milestoneGroupEyebrow(occasion: MilestoneGroupOccasion): string {
  if (occasion.kind === "service") return milestoneEyebrow(occasion.spec);
  if (occasion.kind === "birthday") return birthdayEyebrow(occasion.ordinal);
  return "birthdays at Sato Pharma";
}

/** The earliest and the latest date in a set, and whether every row is on one day. */
export function milestoneGroupWindow(dates: readonly PlainDate[]): {
  first: PlainDate;
  last: PlainDate;
  shared: boolean;
} {
  const sorted = [...dates].sort(comparePlainDates);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return { first, last, shared: comparePlainDates(first, last) === 0 };
}

/**
 * The masthead date — one day, or the window the occasions fall in.
 *
 * Collapsed so a month or a year is never printed twice: "3 – 27 September 2026", not
 * "3 September 2026 – 27 September 2026". An en dash, because it is a range and not a hyphenation.
 */
export function milestoneGroupHeadline(dates: readonly PlainDate[]): string {
  const { first, last, shared } = milestoneGroupWindow(dates);
  if (shared) return formatPlainDateLong(first);
  if (first.year === last.year && first.month === last.month) {
    return `${first.day} – ${last.day} ${monthName(first.month)} ${first.year}`;
  }
  if (first.year === last.year) {
    return `${first.day} ${monthName(first.month)} – ${last.day} ${monthName(last.month)} ${first.year}`;
  }
  return `${formatPlainDateLong(first)} – ${formatPlainDateLong(last)}`;
}

/** The right label on the base bar — the single card's dotted date, or the window. */
export function milestoneGroupFooterRight(dates: readonly PlainDate[]): string {
  const { first, shared } = milestoneGroupWindow(dates);
  if (!shared) return milestoneGroupHeadline(dates);
  return `${String(first.day).padStart(2, "0")} . ${String(first.month).padStart(2, "0")} . ${first.year}`;
}

/**
 * The sentence under the date.
 *
 * It names the OCCASION and the number of people, never the people — their names are set under
 * their own faces, and repeating five of them here would be a paragraph. It follows the single
 * card's wording so the two pieces read as one family.
 */
export function milestoneGroupCitation(input: {
  occasion: MilestoneGroupOccasion;
  count: number;
  dates: readonly PlainDate[];
}): string {
  const { occasion, count, dates } = input;
  const { first, last, shared } = milestoneGroupWindow(dates);
  const when = shared
    ? `On ${formatPlainDateWords(first)}`
    : `Between ${formatPlainDateWords(first)} and ${formatPlainDateWords(last)}`;
  const people = `${numberWords(count)} colleagues`;

  if (occasion.kind === "service") {
    const spec = occasion.spec;
    const served =
      spec.unit === "day"
        ? `${spec.count} days`
        : `${numberWords(spec.count)} ${spec.count === 1 ? spec.unit : `${spec.unit}s`}`;
    if (spec.unit === "year") {
      const plural = spec.count === 1 ? "a year" : `${numberWords(spec.count)} years`;
      return `${when}, ${people} each complete ${served} with Sato Pharma — ${plural} of work, of trust, and of belonging.`;
    }
    return `${when}, ${people} each complete ${served} with Sato Pharma — welcomed, valued, and already one of the family.`;
  }

  const closing = shared
    ? "a day the whole company is glad to share."
    : "days the whole company is glad to share.";
  if (occasion.kind === "birthday") {
    return `${when}, ${people} mark their ${ordinalOf(occasion.ordinal)} birthday at Sato Pharma — ${closing}`;
  }
  return `${when}, ${people} share a birthday at Sato Pharma — ${closing}`;
}

/** "fourth" out of `birthdayEyebrow`'s wording, without duplicating the ordinal table. */
function ordinalOf(ordinal: number): string {
  return birthdayEyebrow(ordinal).replace(/ birthday at Sato Pharma$/, "");
}

/**
 * The file the download lands under — the occasion and the count, in words.
 *
 * Names, never codes (AGENTS.md §4) — and a group has no one name to carry, so the occasion is what
 * names the file: `five-years-5-people-2026-09-30.png`.
 */
export function milestoneGroupFileName(
  occasion: MilestoneGroupOccasion,
  dates: readonly PlainDate[],
  count: number,
  extension: "pdf" | "png" = "png",
): string {
  const label =
    occasion.kind === "service"
      ? milestoneStripLabel(occasion.spec)
      : occasion.kind === "birthday"
        ? birthdayStripLabel(occasion.ordinal)
        : "birthdays";
  const slug = label.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const { first } = milestoneGroupWindow(dates);
  return `${slug || "milestone"}-${count}-people-${formatPlainDateIso(first)}.${extension}`;
}
