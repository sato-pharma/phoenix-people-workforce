// Service milestones — the arithmetic and the words. No I/O, no rendering.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A MILESTONE IS HERE. A hire date plus a period: one month, one year, or anything the owner
// types (six months, three years, a hundred days). The module answers three questions and nothing
// else — WHEN does it fall, WHAT does the card call it, and WHO is due one inside a window.
//
// 🔴 EVERY DATE IN THIS FILE IS A CALENDAR DATE, NEVER A `Date`. `employees.hire_date` is a SQL
// DATE with no time and no zone. Parsing "2026-08-24" with `new Date()` produces midnight UTC,
// which is 02:00 Cairo the same day — and printing it back through any local formatter on a machine
// WEST of UTC returns the 23rd. The app reports Africa/Cairo (AGENTS.md §4) and the laptop that
// runs the tests sits at +03:00, so the bug would never show locally and would surface on the
// Railway container, on one day in three, as a card celebrating the wrong date. A plain
// {year, month, day} triple cannot express the bug at all.
//
// 🔴 MONTH ARITHMETIC CLAMPS, IT DOES NOT ROLL OVER. 31 January + 1 month is the 28th of February
// (29th in a leap year), never the 3rd of March. Anyone hired on a 29th, 30th or 31st gets a
// milestone inside the month a reader expects to see it in.

/** A calendar date with no time and no zone — the only date type this module knows. */
export type PlainDate = { year: number; month: number; day: number };

export type MilestoneUnit = "day" | "month" | "year";

/** A period measured from the hire date: `{ count: 1, unit: "month" }` is the first month. */
export type MilestoneSpec = { count: number; unit: MilestoneUnit };

/** What the picker offers before anyone types their own. The first two are the owner's own cases. */
export const MILESTONE_PRESETS: readonly MilestoneSpec[] = [
  { count: 1, unit: "month" },
  { count: 3, unit: "month" },
  { count: 6, unit: "month" },
  { count: 1, unit: "year" },
  { count: 2, unit: "year" },
  { count: 3, unit: "year" },
  { count: 5, unit: "year" },
  { count: 10, unit: "year" },
  { count: 15, unit: "year" },
  { count: 20, unit: "year" },
  { count: 25, unit: "year" },
];

/** The periods a due-list sweeps when nobody named one. Days are deliberately absent: nobody
 *  celebrates an arbitrary day count on a schedule, and sweeping them would flood the list. */
export const MILESTONE_SWEEP: readonly MilestoneSpec[] = MILESTONE_PRESETS.filter(
  (spec) => !(spec.unit === "month" && spec.count === 3),
);

export class MilestoneSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MilestoneSpecError";
  }
}

const MAX_COUNT: Record<MilestoneUnit, number> = { day: 20000, month: 600, year: 60 };

/**
 * Read a period the way the owner types one: `1m`, `6 months`, `1y`, `3 years`, `100d`, `100 days`.
 * A bare number means months, because the first case this module was built for is a first month.
 */
export function parseMilestoneSpec(input: string | MilestoneSpec | null | undefined): MilestoneSpec {
  if (input && typeof input === "object") return normalizeSpec(input.count, input.unit);
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) throw new MilestoneSpecError("Name a period — one month, one year, or your own.");

  const match = /^(\d+)\s*(d|day|days|m|mo|month|months|y|yr|year|years)?$/.exec(raw);
  if (!match) throw new MilestoneSpecError(`"${input}" is not a period. Try 1m, 6 months, 1y or 100 days.`);

  const count = Number(match[1]);
  const word = match[2] ?? "m";
  const unit: MilestoneUnit = word.startsWith("d") ? "day" : word.startsWith("y") ? "year" : "month";
  return normalizeSpec(count, unit);
}

function normalizeSpec(count: number, unit: MilestoneUnit): MilestoneSpec {
  if (!Number.isInteger(count) || count < 1) {
    throw new MilestoneSpecError("A period must be a whole number of days, months or years.");
  }
  if (count > MAX_COUNT[unit]) {
    throw new MilestoneSpecError(`${count} ${unit}s is past anything this company can have served.`);
  }
  return { count, unit };
}

export function formatMilestoneSpec(spec: MilestoneSpec): string {
  return `${spec.count}${spec.unit === "day" ? "d" : spec.unit === "year" ? "y" : "m"}`;
}

// ── Birthdays at Sato Pharma ─────────────────────────────────────────────────
//
// 🔴 THIS COUNTS BIRTHDAYS AT SATO PHARMA, NEVER THE PERSON'S AGE. The owner, 2026-09-23:
// "you will make it count … this is the first birthday for this employee in Sato Pharma, this is
// the second birthday in his Sato Pharma … and of course mention the birthday date." So the ordinal
// is measured from the HIRE date, and the age is not merely left unprinted — `MonthDay` carries no
// year, which makes the age UNREPRESENTABLE by the type that flows to the card.

/** The month and day of a birthday, with NO year — so an age cannot be derived from it. */
export type MonthDay = { month: number; day: number };

/** Read the month/day of a birth date, dropping the year. Null for a record with no usable date. */
export function monthDayOf(value: PlainDate | string | null | undefined): MonthDay | null {
  const date = typeof value === "string" || value == null ? parsePlainDate(value ?? null) : value;
  if (!date) return null;
  return { month: date.month, day: date.day };
}

/**
 * The date a birthday falls on in one calendar year. CLAMPS, exactly like the milestone arithmetic:
 * 29 February in a common year becomes 28 February, never 1 March. That clamp is why leap-day staff
 * are reminded at all — before it, a 29-February birthday matched no day of a common year.
 */
export function monthDayOn(birthday: MonthDay, year: number): PlainDate {
  return { year, month: birthday.month, day: Math.min(birthday.day, daysInMonth(year, birthday.month)) };
}

/**
 * The FIRST birthday celebrated at Sato Pharma — the first time the birth month/day falls on or
 * after the hire date. Hired ON the birthday counts as the first.
 */
export function firstSatoBirthday(hire: PlainDate, birthday: MonthDay): PlainDate {
  const inHireYear = monthDayOn(birthday, hire.year);
  return comparePlainDates(inHireYear, hire) >= 0 ? inHireYear : monthDayOn(birthday, hire.year + 1);
}

/** Which birthday at Sato Pharma a given celebration is — 1 for the first. */
export function satoBirthdayOrdinal(on: PlainDate, first: PlainDate): number {
  return on.year - first.year + 1;
}

/** The next Sato-Pharma birthday on or after `from`, with its ordinal. */
export function nextSatoBirthday(
  hire: PlainDate,
  birthday: MonthDay,
  from: PlainDate,
): { ordinal: number; on: PlainDate; birthday: MonthDay } {
  const first = firstSatoBirthday(hire, birthday);
  let year = Math.max(from.year, first.year);
  let on = monthDayOn(birthday, year);
  if (comparePlainDates(on, from) < 0) {
    year += 1;
    on = monthDayOn(birthday, year);
  }
  return { ordinal: satoBirthdayOrdinal(on, first), on, birthday };
}

/** Every Sato-Pharma birthday that falls inside `[from, to]`, earliest first. */
export function satoBirthdaysBetween(
  hire: PlainDate,
  birthday: MonthDay,
  from: PlainDate,
  to: PlainDate,
): { ordinal: number; on: PlainDate; birthday: MonthDay }[] {
  const first = firstSatoBirthday(hire, birthday);
  const hits: { ordinal: number; on: PlainDate; birthday: MonthDay }[] = [];
  for (let year = from.year; year <= to.year; year += 1) {
    if (year < first.year) continue;
    const on = monthDayOn(birthday, year);
    if (comparePlainDates(on, from) >= 0 && comparePlainDates(on, to) <= 0) {
      hits.push({ ordinal: satoBirthdayOrdinal(on, first), on, birthday });
    }
  }
  return hits.sort((a, b) => comparePlainDates(a.on, b.on));
}

/** The short spec form a birthday takes in the record and on the wire: `b1`, `b4`. */
export function birthdaySpec(ordinal: number): string {
  return `b${ordinal}`;
}

// The birthday card's words. The tile counts WHICH birthday at Sato Pharma it is, the strip and the
// citation print the birthday DATE, and NOTHING here is the person's age.

/** The numeral on the tile — "01", "04", "12". The ordinal, two digits, like a service milestone. */
export function birthdayTileNumeral(ordinal: number): string {
  return ordinal < 10 ? `0${ordinal}` : String(ordinal);
}

/** The word under the numeral — "BIRTHDAY" (singular, always). Upper-cased by the card, not here. */
export function birthdayTileUnit(): string {
  return "birthday";
}

/** The eyebrow over the name — "first birthday at Sato Pharma". */
export function birthdayEyebrow(ordinal: number): string {
  return `${ordinalWord(ordinal)} birthday at Sato Pharma`;
}

/** The middle cell of the figures strip — "Fourth birthday" (over the date, which the card sets). */
export function birthdayStripLabel(ordinal: number): string {
  const word = ordinalWord(ordinal);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} birthday`;
}

/**
 * The sentence under the name on a birthday card. NO PRONOUNS (like `milestoneCitation`), and NO
 * AGE — it marks the birthday and names the ordinal at Sato Pharma, never a number of years lived.
 * "marks", never "completes": nobody completes a birthday.
 */
export function birthdayCitation(input: { firstName: string; ordinal: number; on: PlainDate }): string {
  const { firstName, ordinal, on } = input;
  return `On ${formatPlainDateWords(on)}, ${firstName} marks ${ordinalWord(ordinal)} birthday at Sato Pharma — a day the whole company is glad to share.`;
}

// ── The calendar's milestone ladder ──────────────────────────────────────────
//
// "first month and then yearly" — the owner, 2026-09-23, redefining the sweep for the HR Calendar.
// The first month, then EVERY year, including the ones the preset ladder skips (4th, 6th, 7th…).
// This is NOT `MILESTONE_SWEEP`: it drops six-months and fills in every missing year.

/**
 * The specs the HR Calendar marks for one hire: the first month, then every year through
 * `throughYear`. Capped at 60 years — the ceiling `normalizeSpec` allows — and the literals are
 * built directly so a 61st year cannot throw the whole calendar.
 */
export function calendarMilestoneSpecs(hire: PlainDate, throughYear: number): MilestoneSpec[] {
  const specs: MilestoneSpec[] = [{ count: 1, unit: "month" }];
  const years = Math.min(Math.max(0, throughYear - hire.year + 1), MAX_COUNT.year);
  for (let count = 1; count <= years; count += 1) specs.push({ count, unit: "year" });
  return specs;
}

// ── Calendar dates ────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Read the leading `YYYY-MM-DD` of a SQL date or timestamp. Returns null rather than guessing. */
export function parsePlainDate(value: string | null | undefined): PlainDate | null {
  const match = ISO_DATE.exec(String(value ?? "").trim());
  if (!match) return null;
  const date: PlainDate = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12) return null;
  if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  return date;
}

export function formatPlainDateIso(date: PlainDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function comparePlainDates(a: PlainDate, b: PlainDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Today in Africa/Cairo, as a calendar date. The app reports Cairo time, never raw UTC. */
export function todayInCairo(now: Date = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = parsePlainDate(parts);
  if (!date) throw new Error("Africa/Cairo date could not be resolved.");
  return date;
}

/**
 * The date a milestone falls on. Months and years CLAMP to the end of the target month — see the
 * header. Days are counted through the civil calendar, so leap days are included.
 */
export function milestoneDate(hire: PlainDate, spec: MilestoneSpec): PlainDate {
  if (spec.unit === "day") return addDays(hire, spec.count);
  const months = spec.unit === "year" ? spec.count * 12 : spec.count;
  const zero = hire.year * 12 + (hire.month - 1) + months;
  const year = Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  return { year, month, day: Math.min(hire.day, daysInMonth(year, month)) };
}

export function addDays(date: PlainDate, days: number): PlainDate {
  let { year, month, day } = date;
  day += days;
  for (;;) {
    const size = daysInMonth(year, month);
    if (day <= size) break;
    day -= size;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month, day };
}

/** Every sweep milestone a hire date produces inside `[from, to]`, earliest first. */
export function milestonesBetween(
  hire: PlainDate,
  from: PlainDate,
  to: PlainDate,
  specs: readonly MilestoneSpec[] = MILESTONE_SWEEP,
): { spec: MilestoneSpec; on: PlainDate }[] {
  const hits: { spec: MilestoneSpec; on: PlainDate }[] = [];
  for (const spec of specs) {
    const on = milestoneDate(hire, spec);
    if (comparePlainDates(on, from) >= 0 && comparePlainDates(on, to) <= 0) hits.push({ spec, on });
  }
  return hits.sort((a, b) => comparePlainDates(a.on, b.on));
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * `Date.UTC` is safe here and only here: both ends are built at UTC midnight from the same triple,
 * so the difference is exact and the local zone never enters it. A DST jump cannot reach UTC.
 */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "September" — the month alone, so a date RANGE need not print the month twice. */
export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/** "Sep" — the three-letter form, for a 46pt seal that cannot hold "SEPTEMBER". */
export function monthNameShort(month: number): string {
  return monthName(month).slice(0, 3);
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** `numberWords(25)` is "twenty-five". Past 99 the digits are the honest answer. */
export function numberWords(n: number): string {
  if (n < 0 || !Number.isInteger(n)) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) {
    const unit = n % 10;
    return unit === 0 ? TENS[Math.floor(n / 10)] : `${TENS[Math.floor(n / 10)]}-${ONES[unit]}`;
  }
  return String(n);
}

const ORDINAL_ONES = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
  "eighteenth", "nineteenth", "twentieth",
];

/** The day of the month in words — "twenty-fifth". Days only, so 1–31 is the whole range. */
export function ordinalDayWords(day: number): string {
  if (day <= 20) return ORDINAL_ONES[day] ?? String(day);
  if (day === 30) return "thirtieth";
  const unit = day % 10;
  if (unit === 0) return "thirtieth";
  return `${TENS[Math.floor(day / 10)]}-${ORDINAL_ONES[unit]}`;
}

const ORDINAL_TENS = ["", "", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth"];

/**
 * An ordinal in words for any count, not just a day — "fourth", "twenty-first", "fortieth". Used
 * for a birthday's ordinal, which counts birthdays at Sato Pharma and can pass 31 (the day range
 * `ordinalDayWords` covers). Past 60 — beyond anyone's service — the numeral is the honest answer.
 */
export function ordinalWord(n: number): string {
  if (n <= 0 || !Number.isInteger(n)) return String(n);
  if (n <= 20) return ORDINAL_ONES[n] ?? String(n);
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const unit = n % 10;
    if (unit === 0) return ORDINAL_TENS[tens] ?? String(n);
    return `${TENS[tens]}-${ORDINAL_ONES[unit]}`;
  }
  return String(n);
}

/** "25 September 2026" — the form every date on the card and in the list takes. */
export function formatPlainDateLong(date: PlainDate): string {
  return `${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

/** "the twenty-fifth of September 2026" — the citation's form. */
export function formatPlainDateWords(date: PlainDate): string {
  return `the ${ordinalDayWords(date.day)} of ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

function unitWord(spec: MilestoneSpec): string {
  return spec.count === 1 ? spec.unit : `${spec.unit}s`;
}

/** The numeral on the commemorative tile — "01", "10", "100". */
export function milestoneTileNumeral(spec: MilestoneSpec): string {
  return spec.count < 10 ? `0${spec.count}` : String(spec.count);
}

/** The word under the numeral — "MONTH", "YEARS". Upper-cased by the card, not here. */
export function milestoneTileUnit(spec: MilestoneSpec): string {
  return unitWord(spec);
}

/** The eyebrow over the name — "One month at Sato Pharma". */
export function milestoneEyebrow(spec: MilestoneSpec): string {
  return `${numberWords(spec.count)} ${unitWord(spec)} at Sato Pharma`;
}

/** The middle cell of the figures strip — "First month", "Three years", "100 days". */
export function milestoneStripLabel(spec: MilestoneSpec): string {
  if (spec.count === 1) return `First ${spec.unit}`;
  if (spec.unit === "day") return `${spec.count} days`;
  return `${numberWords(spec.count)} ${unitWord(spec)}`;
}

/**
 * The sentence under the name.
 *
 * NO PRONOUNS, DELIBERATELY. The card is printed for whoever the milestone belongs to, and the
 * employees table's `gender` column is not something a keepsake should depend on being right.
 * Nothing here needs one: the name is set directly above the sentence.
 */
export function milestoneCitation(input: {
  firstName: string;
  spec: MilestoneSpec;
  on: PlainDate;
}): string {
  const { firstName, spec, on } = input;
  const when = `On ${formatPlainDateWords(on)}`;
  const served =
    spec.unit === "day"
      ? `${spec.count} days`
      : `${numberWords(spec.count)} ${unitWord(spec)}`;

  if (spec.unit === "year") {
    const plural = spec.count === 1 ? "a year" : `${numberWords(spec.count)} years`;
    return `${when}, ${firstName} completes ${served} with Sato Pharma — ${plural} of work, of trust, and of belonging.`;
  }
  return `${when}, ${firstName} completes ${served} with Sato Pharma — welcomed, valued, and already one of the family.`;
}

/**
 * The file name a download lands under. Names, never codes (AGENTS.md §4) — the HR id is not in it.
 */
export function milestoneFileName(
  fullName: string,
  spec: MilestoneSpec,
  on: PlainDate,
  extension: "pdf" | "png" = "pdf",
): string {
  return milestoneCardFileName(fullName, formatMilestoneSpec(spec), on, extension);
}

/**
 * The download name from a spec STRING rather than a `MilestoneSpec`, so a birthday (`b4`) names its
 * file too — a birthday is not a `MilestoneSpec` and has no `count`/`unit` to format.
 */
export function milestoneCardFileName(
  fullName: string,
  periodSpec: string,
  on: PlainDate,
  extension: "pdf" | "png" = "pdf",
): string {
  const name = fullName.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "employee";
  return `${name}-${periodSpec}-${formatPlainDateIso(on)}.${extension}`;
}

/**
 * The name the card prints. `nickname` wins when HR recorded one — a legal name of five parts is
 * not what anybody is called, and the card is a gift, not a record.
 */
export function cardDisplayName(fullName: string, nickname?: string | null): string {
  const nick = (nickname ?? "").trim();
  if (nick) return nick;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 3) return parts.join(" ");
  return [parts[0], parts[1], parts[parts.length - 1]].join(" ");
}

/** The name the citation uses — one word, the one a colleague would say. */
export function cardFirstName(fullName: string, nickname?: string | null): string {
  const source = (nickname ?? "").trim() || fullName.trim();
  return source.split(/\s+/)[0] ?? source;
}
