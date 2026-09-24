// Who is due a milestone, and everything one card needs.
//
// The domain service. Routes and pages call THIS; they never assemble a card themselves.
//
// 🔴 A LEAVER IS NEVER DUE A MILESTONE. The window sweep runs over the live directory through
// `isActiveDirectoryEmployee`, which is the same predicate the organogram and every team scope
// use — so a resigned, terminated or system account cannot surface here, and a declined offer
// drops out the moment HR records it.
//
// 🔴 THE HIRE DATE IS THE ONLY INPUT, AND IT IS OFTEN WRONG BY A DAY. `employees.hire_date` is
// what HR typed, not what the contract says; the owner has settled before that the recorded hire
// date is the one to trust ("trust hiring date"). This module therefore never corrects it, and it
// prints BOTH dates on the card — Joined and the milestone — so a reader can see the arithmetic.

import { getEmployeeDirectory, isActiveDirectoryEmployee, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { streamEmployeePhoto } from "@/lib/employees/employee-photo";

import { type MilestoneCardInput } from "./card";
import {
  loadMilestonePrintHistory,
  loadMilestonePrintMarks,
  occurrenceKey,
  type MilestonePhotoSource,
  type MilestonePrintHistoryRow,
} from "./ledger";
import {
  birthdayCitation,
  birthdaySpec,
  birthdayStripLabel,
  cardDisplayName,
  cardFirstName,
  comparePlainDates,
  daysBetween,
  firstSatoBirthday,
  formatMilestoneSpec,
  formatPlainDateIso,
  formatPlainDateLong,
  milestoneCitation,
  milestoneDate,
  milestoneStripLabel,
  milestonesBetween,
  monthDayOf,
  monthDayOn,
  parseMilestoneSpec,
  parsePlainDate,
  satoBirthdaysBetween,
  todayInCairo,
  MILESTONE_SWEEP,
  type MilestoneSpec,
  type PlainDate,
} from "./periods";
import {
  polishPortraitDataUri,
  portraitFocus,
  portraitInitials,
  type PortraitFocus,
} from "./portrait";

/** How wide the polished portrait is rendered. The card prints it 350pt, so this is ~360 DPI. */
const PORTRAIT_WIDTH = 1750;

export type MilestoneDueEntry = {
  hrId: string;
  displayName: string;
  fullName: string;
  roleLine: string;
  hireDate: string;
  /** A service milestone, or a birthday at Sato Pharma. */
  kind: "service" | "birthday";
  /** The period, in the short form the API takes back: `1m`, `1y`, or `b4` for a birthday. */
  spec: string;
  specLabel: string;
  /** The milestone date, ISO. */
  on: string;
  /** Negative when it has already passed. */
  daysAway: number;
  hasPhoto: boolean;
  /**
   * A card has already been printed for this exact occurrence — the owner's "already congratulated"
   * tick. Fails towards NOT ticked: an unreadable print log hides the mark rather than inventing one.
   */
  printed: boolean;
};

/**
 * One person the picker can choose, whether or not anything is due.
 *
 * 🔴 THE DUE LIST IS NOT THE ROSTER. A window of thirty days answers "who is coming up"; it does
 * NOT answer "make a card for this person". The owner asked for the second — type a name, get the
 * person — and every active employee is a legitimate answer, including somebody whose milestone
 * passed last month and somebody whose next one is two years out.
 *
 * `hireDate` is null for a record HR has not dated. That person still appears here, deliberately:
 * being absent from a picker with no explanation reads as a bug, while a row that says why it
 * cannot be used tells the truth and points at the record to fix.
 */
export type MilestoneCandidate = {
  hrId: string;
  displayName: string;
  fullName: string;
  roleLine: string;
  hireDate: string | null;
  hasPhoto: boolean;
};

/** Every active employee, by name. The same `isActiveDirectoryEmployee` predicate as the sweep. */
export async function listMilestoneCandidates(): Promise<MilestoneCandidate[]> {
  const { employees } = await getEmployeeDirectory();
  return employees
    .filter((employee) => isActiveDirectoryEmployee(employee))
    .map((employee) => {
      const hire = parsePlainDate(employee.hireDate);
      return {
        hrId: employee.hrId,
        displayName: cardDisplayName(employee.fullName, employee.nickname),
        fullName: employee.fullName,
        roleLine: roleLineFor(employee),
        hireDate: hire ? formatPlainDateIso(hire) : null,
        hasPhoto: employee.hasPhoto,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.hrId.localeCompare(b.hrId));
}

// ── The print history ────────────────────────────────────────────────────────────────────────
//
// The record (milestone_card_prints) written on every print, read back for a Super Admin to see who
// was congratulated over any window — the reader the append-only log was built for. Names, never
// codes (AGENTS.md §4); the print time is Cairo local, never raw UTC.

/** One row of the print history, shaped for the screen and the XLSX. */
export type MilestonePrintHistoryEntry = {
  /** The raw print instant (created_at) — the sort key and a stable row key. */
  printedAtIso: string;
  /** The print instant in Cairo local, "DD Mon YYYY, HH:mm". */
  printedAt: string;
  subjectHrId: string;
  /** The name as the card carried it — that IS the person congratulated. */
  subjectName: string;
  kind: "service" | "birthday";
  /** "First year", "Fourth birthday" — worked from the stored spec. */
  occasion: string;
  /** The milestone/birthday date the card marked, in full. */
  milestoneOn: string;
  format: string;
  photoSource: MilestonePhotoSource;
  /** Who printed it, by name where the HR id resolves. */
  actorName: string;
};

/** Sentence-case, so the service label ("five years") reads like the birthday label ("Fourth birthday"). */
function sentenceCase(label: string): string {
  return label.length === 0 ? label : `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/**
 * The occasion label from a stored spec string (`1m`, `1y`, `b4`). Birthdays are not a MilestoneSpec.
 * The strip helpers disagree on casing — `birthdayStripLabel` capitalises, `milestoneStripLabel` does
 * not — so the screen sentence-cases both to one voice.
 */
function historyOccasionLabel(periodSpec: string): { kind: "service" | "birthday"; label: string } {
  const birthday = /^b(\d+)$/i.exec(periodSpec.trim());
  if (birthday) return { kind: "birthday", label: sentenceCase(birthdayStripLabel(Number(birthday[1]))) };
  try {
    return { kind: "service", label: sentenceCase(milestoneStripLabel(parseMilestoneSpec(periodSpec))) };
  } catch {
    return { kind: "service", label: periodSpec };
  }
}

/** A timestamptz → Cairo local, the owner's rule (never raw UTC). Falls back to the raw string. */
function formatCairoDateTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Shape one log row for display. Pure and separated on purpose — this is the part worth pinning in a
 * test, and it must be checkable without a database. `resolveName` turns an HR id into a name.
 */
export function buildMilestonePrintHistoryEntry(
  row: MilestonePrintHistoryRow,
  resolveName: (hrId: string | null) => string | null,
): MilestonePrintHistoryEntry {
  const occasion = historyOccasionLabel(row.period_spec);
  const on = parsePlainDate(row.milestone_on);
  return {
    printedAtIso: row.created_at,
    printedAt: formatCairoDateTime(row.created_at),
    subjectHrId: row.subject_hr_id,
    subjectName: row.printed_name?.trim() || resolveName(row.subject_hr_id) || row.subject_hr_id,
    kind: occasion.kind,
    occasion: occasion.label,
    milestoneOn: on ? formatPlainDateLong(on) : row.milestone_on,
    format: (row.format || "").toUpperCase() || "PDF",
    photoSource: row.photo_source,
    actorName: row.actor_name?.trim() || resolveName(row.actor_hr_id) || row.actor_login_id || "—",
  };
}

/** The print history over a window of print dates (ISO `YYYY-MM-DD`), newest first, names resolved. */
export async function getMilestonePrintHistory(options: {
  fromIso: string;
  toIso: string;
  limit?: number;
}): Promise<MilestonePrintHistoryEntry[]> {
  const rows = await loadMilestonePrintHistory(options.fromIso, options.toIso, options.limit ?? 1000);
  if (rows.length === 0) return [];
  const { employees } = await getEmployeeDirectory();
  const names = new Map<string, string>();
  for (const employee of employees) {
    names.set(employee.hrId.trim().toUpperCase(), cardDisplayName(employee.fullName, employee.nickname));
  }
  const resolve = (hrId: string | null): string | null =>
    hrId ? names.get(hrId.trim().toUpperCase()) ?? null : null;
  return rows.map((row) => buildMilestonePrintHistoryEntry(row, resolve));
}

export type MilestoneDueOptions = {
  /** Defaults to today in Cairo. */
  from?: PlainDate;
  /** Defaults to 30 days after `from`. */
  to?: PlainDate;
  specs?: readonly MilestoneSpec[];
};

/**
 * Everybody whose milestone or Sato-Pharma birthday falls inside the window, soonest first.
 *
 * 🔴 THIS IS THE SAME WINDOW THE PUMP REMINDS ABOUT, so the page a reminder points at shows exactly
 * what the reminder listed — service milestones AND birthdays — and opening it marks both seen.
 *
 * One person can appear more than once — a month and a year milestone can fall together, and a
 * birthday sits beside either. Each row carries its own `printed` mark: a card already made for that
 * exact occurrence.
 */
export async function listMilestonesDue(options: MilestoneDueOptions = {}): Promise<MilestoneDueEntry[]> {
  const from = options.from ?? todayInCairo();
  const to = options.to ?? addDaysPlain(from, 30);
  if (comparePlainDates(from, to) > 0) {
    throw new Error("The milestone window ends before it starts.");
  }

  const { employees } = await getEmployeeDirectory();
  const today = todayInCairo();
  // Which occurrences already have a printed card — global, keyed on the arithmetic occurrence.
  const printed = await loadMilestonePrintMarks(from, to);
  const entries: MilestoneDueEntry[] = [];

  for (const employee of employees) {
    if (!isActiveDirectoryEmployee(employee)) continue;
    const hire = parsePlainDate(employee.hireDate);
    if (!hire) continue;
    const displayName = cardDisplayName(employee.fullName, employee.nickname);
    const roleLine = roleLineFor(employee);
    const hireIso = formatPlainDateIso(hire);

    for (const hit of milestonesBetween(hire, from, to, options.specs ?? MILESTONE_SWEEP)) {
      const spec = formatMilestoneSpec(hit.spec);
      const onIso = formatPlainDateIso(hit.on);
      entries.push({
        hrId: employee.hrId,
        displayName,
        fullName: employee.fullName,
        roleLine,
        hireDate: hireIso,
        kind: "service",
        spec,
        specLabel: milestoneStripLabel(hit.spec),
        on: onIso,
        daysAway: daysBetween(today, hit.on),
        hasPhoto: employee.hasPhoto,
        printed: printed.has(occurrenceKey({ subjectHrId: employee.hrId, periodSpec: spec, derivedOn: onIso })),
      });
    }

    // Birthdays never surface for a preset-specs query (a batch of one preset); a caller that asks
    // for its own specs is after service milestones only.
    if (options.specs) continue;
    const birthday = monthDayOf(employee.birthDate);
    if (!birthday) continue;
    for (const hit of satoBirthdaysBetween(hire, birthday, from, to)) {
      const spec = birthdaySpec(hit.ordinal);
      const onIso = formatPlainDateIso(hit.on);
      entries.push({
        hrId: employee.hrId,
        displayName,
        fullName: employee.fullName,
        roleLine,
        hireDate: hireIso,
        kind: "birthday",
        spec,
        specLabel: birthdayStripLabel(hit.ordinal),
        on: onIso,
        daysAway: daysBetween(today, hit.on),
        hasPhoto: employee.hasPhoto,
        printed: printed.has(occurrenceKey({ subjectHrId: employee.hrId, periodSpec: spec, derivedOn: onIso })),
      });
    }
  }

  return entries.sort(
    (a, b) => a.on.localeCompare(b.on) || a.displayName.localeCompare(b.displayName),
  );
}

export type BuildMilestoneCardOptions = {
  hrId: string;
  /** `1m`, `6 months`, `1y`, `100 days` — whatever the owner typed. */
  spec: string | MilestoneSpec;
  /** Override the computed date. The owner's own call wins over the arithmetic. */
  on?: PlainDate | null;
  /**
   * Override the name printed on the card.
   *
   * 🔴 AN HR RECORD HOLDS A LEGAL NAME, WHICH IS OFTEN NOT WHAT SOMEBODY IS CALLED. HR-009's
   * record reads "Yasmeena Khaled Ahmed Hussein Elsafory"; the card the owner approved says
   * "Yasmeen Khaled Elsafory". A keepsake somebody takes home should carry the name they answer
   * to, and only a person can say what that is — so it is an override here, never a guess.
   *
   * The citation's first name follows this, so the card cannot name her one thing in script and
   * address her as another in the sentence below it.
   */
  displayName?: string | null;
  /** Override the sentence under the name. */
  citation?: string | null;
  /** Skip the photograph and print the monogram plate. */
  withoutPhoto?: boolean;
  /**
   * Where the 4:5 window sits on the photograph, when the person framing it has moved it.
   *
   * 🔴 THE FRAME NEVER MOVES; THE PICTURE INSIDE IT DOES. The card's portrait is a fixed rectangle
   * on a printed sheet — its size, its keyline and its corner ticks are the design, and none of
   * them are negotiable. What a photograph does inside that rectangle is a different question, and
   * one only a person looking at the face can answer: a head sitting too low, a shoulder cut, a
   * phone picture taken at arm's length. Omit this and sharp's `attention` crop decides, exactly
   * as it always has.
   */
  photoFocus?: PortraitFocus | null;
  /**
   * A photograph handed in for this one card, instead of the one on the HR record.
   *
   * 🔴 THE RECORD IS OFTEN THE WRONG PLACE TO LOOK FOR A FACE. Plenty of people have never
   * uploaded one, and a card for somebody with no photograph on file is the commonest reason this
   * module has nothing to print — "if someone is not putting the photo, from where I will get his
   * photo" (the owner, 2026-09-23). It also overrides a photograph that IS there: a keepsake
   * somebody takes home deserves a better picture than the one taken on their first morning for a
   * building pass.
   *
   * It is used for this render and NOTHING else. It is never written to the employee record, never
   * put in the photo bucket, and never seen by any other screen — changing what the directory
   * holds is HR's act on HR's screen, not a side effect of printing a card. It goes through the
   * identical portrait treatment as a stored photograph, so an uploaded picture and a recorded one
   * print the same.
   */
  photoUpload?: Buffer | null;
};

export class MilestoneEmployeeNotFoundError extends Error {
  constructor(hrId: string) {
    super(`No employee record for ${hrId}.`);
    this.name = "MilestoneEmployeeNotFoundError";
  }
}

export class MilestoneHireDateMissingError extends Error {
  constructor(name: string) {
    super(`${name} has no hire date on record, so there is no milestone to date.`);
    this.name = "MilestoneHireDateMissingError";
  }
}

export class MilestoneBirthDateMissingError extends Error {
  constructor(name: string) {
    super(`${name} has no birth date on record, so there is no birthday to date.`);
    this.name = "MilestoneBirthDateMissingError";
  }
}

/** A birthday period the owner (or a calendar link) can name: `b1`, `b4`. NOT a `MilestoneSpec`. */
const BIRTHDAY_SPEC = /^b(\d+)$/i;

/**
 * What one built card carries back.
 *
 * 🔴 `spec` IS NULL FOR A BIRTHDAY, and `periodSpec`/`derivedOn` are the fields the ledger and the
 * filename read for EITHER kind. A birthday is not a `count`/`unit` `MilestoneSpec` — its date comes
 * from the birth date and the tenure, not from hire + a duration — so the arithmetic identity is
 * carried as the canonical spec string and the arithmetic date, computed once here.
 */
export type BuiltMilestoneCard = {
  input: MilestoneCardInput;
  /** The service spec, or null for a birthday. */
  spec: MilestoneSpec | null;
  /** The canonical spec string — `1y`, `b4` — half of the occurrence identity, and the file name. */
  periodSpec: string;
  /** The arithmetic date: the occurrence identity, never the date typed over the card. */
  derivedOn: PlainDate;
  /** The date the card prints — the override when the owner typed one, else `derivedOn`. */
  on: PlainDate;
  employee: EmployeeDirectoryRow;
};

/** Assemble one card: the person, the period (service OR birthday), the polished photograph. */
export async function buildMilestoneCardInput(
  options: BuildMilestoneCardOptions,
): Promise<BuiltMilestoneCard> {
  const rawSpec = typeof options.spec === "string" ? options.spec.trim() : options.spec;
  const birthdayMatch = typeof rawSpec === "string" ? BIRTHDAY_SPEC.exec(rawSpec) : null;
  // Parse a service spec eagerly so a malformed one throws before any I/O; a birthday defers.
  const spec = birthdayMatch ? null : parseMilestoneSpec(options.spec);

  const { employees } = await getEmployeeDirectory();
  const key = options.hrId.trim().toLowerCase();
  const employee = employees.find((row) => row.hrId.trim().toLowerCase() === key);
  if (!employee) throw new MilestoneEmployeeNotFoundError(options.hrId);

  const hire = parsePlainDate(employee.hireDate);
  if (!hire) throw new MilestoneHireDateMissingError(employee.fullName);

  const override = options.displayName?.trim() || null;
  const displayName = override ?? cardDisplayName(employee.fullName, employee.nickname);
  const firstName = override
    ? cardFirstName(override)
    : cardFirstName(employee.fullName, employee.nickname);

  // The photograph is best-effort at every step: missing from the bucket, unreadable, or a format
  // sharp will not open — the card prints the monogram plate rather than failing.
  //
  // An uploaded picture wins over the record's, and is the only source when the record has none.
  // `withoutPhoto` still beats both: asking for the monogram plate is an instruction, not a
  // fallback, and an upload does not quietly overrule it.
  let photoDataUri: string | null = null;
  if (!options.withoutPhoto) {
    try {
      const bytes = options.photoUpload ?? (employee.hasPhoto ? (await streamEmployeePhoto(employee.hrId))?.bytes : null);
      if (bytes) {
        photoDataUri = await polishPortraitDataUri(bytes, {
          width: PORTRAIT_WIDTH,
          focus: options.photoFocus ?? null,
        });
      }
    } catch {
      photoDataUri = null;
    }
  }

  const shared = {
    displayName,
    roleLine: roleLineFor(employee),
    employeeId: employee.hrId,
    hireDate: hire,
    photoDataUri,
    initials: portraitInitials(displayName),
  };

  // ── A BIRTHDAY AT SATO PHARMA ──────────────────────────────────────────────────────────────────
  // The ordinal is the count of birthdays celebrated since hire (never an age); the date is that
  // ordinal's birthday, clamped like every other date in this module.
  if (birthdayMatch) {
    const ordinal = Number(birthdayMatch[1]);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new MilestoneEmployeeNotFoundError(options.hrId);
    }
    const birthday = monthDayOf(employee.birthDate);
    if (!birthday) throw new MilestoneBirthDateMissingError(employee.fullName);
    const first = firstSatoBirthday(hire, birthday);
    const derivedOn = monthDayOn(birthday, first.year + ordinal - 1);
    const on = options.on ?? derivedOn;
    return {
      spec: null,
      periodSpec: birthdaySpec(ordinal),
      derivedOn,
      on,
      employee,
      input: {
        ...shared,
        // Never rendered on a birthday card — the tile, eyebrow and strip read `occasion` — but the
        // type requires a spec, so a harmless placeholder rides along.
        spec: { count: 1, unit: "year" },
        on,
        citation: options.citation?.trim() || birthdayCitation({ firstName, ordinal, on }),
        occasion: { kind: "birthday", ordinal },
      },
    };
  }

  // ── A SERVICE MILESTONE (the frozen design) ─────────────────────────────────────────────────────
  const serviceSpec = spec as MilestoneSpec;
  const derivedOn = milestoneDate(hire, serviceSpec);
  const on = options.on ?? derivedOn;
  return {
    spec: serviceSpec,
    periodSpec: formatMilestoneSpec(serviceSpec),
    derivedOn,
    on,
    employee,
    input: {
      ...shared,
      spec: serviceSpec,
      on,
      citation: options.citation?.trim() || milestoneCitation({ firstName, spec: serviceSpec, on }),
    },
  };
}

/**
 * The framing the card would print for this picture if nobody moved it.
 *
 * `upload` is a photograph handed in for this card; without one it reads the HR record's. `null`
 * comes back when there is nothing to frame — no photograph either way, or bytes sharp will not
 * open. The box that does the dragging is then not shown at all, which is the honest answer: there
 * is no picture to move.
 */
export async function milestonePhotoFocus(
  hrId: string,
  upload?: Buffer | null,
): Promise<PortraitFocus | null> {
  try {
    if (upload) return await portraitFocus(upload);
    const photo = await streamEmployeePhoto(hrId);
    if (!photo) return null;
    return await portraitFocus(photo.bytes);
  } catch {
    return null;
  }
}

/**
 * "HR Generalist · Head Office · Cairo".
 *
 * Names, never codes (AGENTS.md §4) — and never a repeat: an employee whose department and line
 * carry the same name would otherwise read "Pedia · Pedia".
 */
function roleLineFor(employee: EmployeeDirectoryRow): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [
    employee.jobTitle,
    employee.departmentName ?? employee.lineName,
    employee.regionName ?? employee.areaName,
  ]) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(value);
  }
  return parts.join("  ·  ");
}

function addDaysPlain(date: PlainDate, days: number): PlainDate {
  const ms = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const moved = new Date(ms);
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}
