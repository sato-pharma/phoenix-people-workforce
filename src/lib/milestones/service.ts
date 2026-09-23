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
  cardDisplayName,
  cardFirstName,
  comparePlainDates,
  daysBetween,
  formatMilestoneSpec,
  formatPlainDateIso,
  milestoneCitation,
  milestoneDate,
  milestoneStripLabel,
  milestonesBetween,
  parseMilestoneSpec,
  parsePlainDate,
  todayInCairo,
  MILESTONE_SWEEP,
  type MilestoneSpec,
  type PlainDate,
} from "./periods";
import { polishPortraitDataUri, portraitInitials } from "./portrait";

/** How wide the polished portrait is rendered. The card prints it 350pt, so this is ~360 DPI. */
const PORTRAIT_WIDTH = 1750;

export type MilestoneDueEntry = {
  hrId: string;
  displayName: string;
  fullName: string;
  roleLine: string;
  hireDate: string;
  /** The period, in the short form the API takes back: `1m`, `1y`. */
  spec: string;
  specLabel: string;
  /** The milestone date, ISO. */
  on: string;
  /** Negative when it has already passed. */
  daysAway: number;
  hasPhoto: boolean;
};

export type MilestoneDueOptions = {
  /** Defaults to today in Cairo. */
  from?: PlainDate;
  /** Defaults to 30 days after `from`. */
  to?: PlainDate;
  specs?: readonly MilestoneSpec[];
};

/**
 * Everybody whose milestone falls inside the window, soonest first.
 *
 * One person can appear twice — somebody hired on the first of a month hits a month and a year
 * milestone on the same day exactly once every twelve years, and both are real.
 */
export async function listMilestonesDue(options: MilestoneDueOptions = {}): Promise<MilestoneDueEntry[]> {
  const from = options.from ?? todayInCairo();
  const to = options.to ?? addDaysPlain(from, 30);
  if (comparePlainDates(from, to) > 0) {
    throw new Error("The milestone window ends before it starts.");
  }

  const { employees } = await getEmployeeDirectory();
  const today = todayInCairo();
  const entries: MilestoneDueEntry[] = [];

  for (const employee of employees) {
    if (!isActiveDirectoryEmployee(employee)) continue;
    const hire = parsePlainDate(employee.hireDate);
    if (!hire) continue;

    for (const hit of milestonesBetween(hire, from, to, options.specs ?? MILESTONE_SWEEP)) {
      entries.push({
        hrId: employee.hrId,
        displayName: cardDisplayName(employee.fullName, employee.nickname),
        fullName: employee.fullName,
        roleLine: roleLineFor(employee),
        hireDate: formatPlainDateIso(hire),
        spec: formatMilestoneSpec(hit.spec),
        specLabel: milestoneStripLabel(hit.spec),
        on: formatPlainDateIso(hit.on),
        daysAway: daysBetween(today, hit.on),
        hasPhoto: employee.hasPhoto,
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

/** Assemble one card: the person, the period, the polished photograph. */
export async function buildMilestoneCardInput(
  options: BuildMilestoneCardOptions,
): Promise<{ input: MilestoneCardInput; spec: MilestoneSpec; on: PlainDate; employee: EmployeeDirectoryRow }> {
  const spec = parseMilestoneSpec(options.spec);
  const { employees } = await getEmployeeDirectory();
  const key = options.hrId.trim().toLowerCase();
  const employee = employees.find((row) => row.hrId.trim().toLowerCase() === key);
  if (!employee) throw new MilestoneEmployeeNotFoundError(options.hrId);

  const hire = parsePlainDate(employee.hireDate);
  if (!hire) throw new MilestoneHireDateMissingError(employee.fullName);

  const on = options.on ?? milestoneDate(hire, spec);
  const override = options.displayName?.trim() || null;
  const displayName = override ?? cardDisplayName(employee.fullName, employee.nickname);
  const firstName = override
    ? cardFirstName(override)
    : cardFirstName(employee.fullName, employee.nickname);

  // The photograph is best-effort at every step: missing from the bucket, unreadable, or a format
  // sharp will not open — the card prints the monogram plate rather than failing.
  let photoDataUri: string | null = null;
  if (!options.withoutPhoto && employee.hasPhoto) {
    try {
      const photo = await streamEmployeePhoto(employee.hrId);
      if (photo) photoDataUri = await polishPortraitDataUri(photo.bytes, { width: PORTRAIT_WIDTH });
    } catch {
      photoDataUri = null;
    }
  }

  return {
    spec,
    on,
    employee,
    input: {
      displayName,
      roleLine: roleLineFor(employee),
      employeeId: employee.hrId,
      hireDate: hire,
      spec,
      on,
      citation: options.citation?.trim() || milestoneCitation({ firstName, spec, on }),
      photoDataUri,
      initials: portraitInitials(displayName),
    },
  };
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
