// Unified Deductions module: governmental-holiday bridging. Pure, no DB I/O.
//
// Owner's rule: a no-record or vacation day taken DIRECTLY BEFORE or DIRECTLY
// AFTER a governmental national holiday (23 June, 6 October and the like) is a
// deduction. "Directly" means the nearest day the person actually WORKS — not
// the raw calendar neighbour.
//
// That distinction is the whole reason this module exists. The neighbour of a
// Thursday holiday is Friday, which the field force never works, so a raw
// calendar step would flag every rep every time and deduct nothing meaningful.
// Stepping over the non-working days lands on Wednesday and Saturday instead —
// but Wednesday and Saturday are the RESULT for one holiday shape, not the
// rule. A Sunday holiday bridges Saturday and Monday; a Wednesday–Thursday
// holiday bridges Tuesday and Saturday. The rule is "nearest working day each
// side of the whole non-working block".
//
// A separate engine already exists at payroll/copilot/holiday-bridging.ts. It
// encodes a DIFFERENT rule on purpose (raw calendar adjacency, approved
// vacation requests only, feeding the payroll sheet) and is left alone; this
// one serves the Deductions module and additionally covers no-record days.

export type HolidayInput = {
  id: string;
  name: string;
  startDate: string;
  endDate: string | null;
};

export type HolidayBridgeDay = {
  /** The working day that is flagged. */
  date: string;
  adjacentTo: "before" | "after";
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
};

/** How far to step looking for a working day before giving up. */
const MAX_STEPS = 14;

export function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function expandHolidayDates(holiday: HolidayInput): string[] {
  const end = holiday.endDate ?? holiday.startDate;
  const dates: string[] = [];
  let cursor = holiday.startDate;
  for (let step = 0; step <= MAX_STEPS && cursor <= end; step += 1) {
    dates.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return dates;
}

/**
 * The nearest day the employee works on each side of a holiday.
 *
 * `isWorkingDay` is injected rather than assumed: Friday is off for everyone,
 * but Saturday is a working day for medical reps and district managers and a
 * day off for head office (see isFieldWorkforceWeeklyOff). Baking one work week
 * in here would silently flag the wrong day for half the company.
 *
 * Holiday days themselves are never a bridge day, and the walk continues
 * through any adjacent holiday, so two governmental holidays separated by a
 * weekend behave as one block rather than manufacturing a bridge day in the
 * middle that nobody worked.
 */
export function computeHolidayBridgeDays(input: {
  holidays: readonly HolidayInput[];
  /** Only bridge days inside this month are returned (YYYY-MM). */
  monthKey: string;
  isWorkingDay: (dateIso: string) => boolean;
}): HolidayBridgeDay[] {
  const holidayDates = new Set<string>();
  for (const holiday of input.holidays) {
    for (const date of expandHolidayDates(holiday)) holidayDates.add(date);
  }

  const isBlocked = (dateIso: string) => holidayDates.has(dateIso) || !input.isWorkingDay(dateIso);

  const found = new Map<string, HolidayBridgeDay>();

  for (const holiday of input.holidays) {
    const end = holiday.endDate ?? holiday.startDate;

    for (const direction of [-1, 1] as const) {
      const from = direction === -1 ? holiday.startDate : end;
      let cursor = addDaysIso(from, direction);
      let steps = 0;
      // Step over every non-working day AND every holiday day until a real
      // working day appears. Bounded so a bad holiday feed cannot spin.
      while (isBlocked(cursor) && steps < MAX_STEPS) {
        cursor = addDaysIso(cursor, direction);
        steps += 1;
      }
      if (isBlocked(cursor)) continue;
      if (!cursor.startsWith(`${input.monthKey}-`)) continue;

      const adjacentTo = direction === -1 ? "before" : "after";
      const key = `${cursor}:${adjacentTo}`;
      // Two holidays can resolve to the same bridge day; keep one entry.
      if (found.has(key)) continue;
      found.set(key, {
        date: cursor,
        adjacentTo,
        holidayName: holiday.name,
        holidayStartDate: holiday.startDate,
        holidayEndDate: end,
      });
    }
  }

  return [...found.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Field-force work week: Friday off, everything else worked.
 *
 * Scoped to the field force on the owner's instruction ("fieldforce only"), so
 * Saturday counts as a working day — that is precisely what makes Saturday the
 * bridge after a Thursday holiday.
 */
export function isFieldForceWorkingDay(dateIso: string): boolean {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() !== 5;
}

/**
 * Drops bridge days for an employee that some other category already charges.
 *
 * Owner's rule: "if vacation with no balance or no record was deducted before
 * same day do not duplicate." The publish-time collision gate would refuse the
 * whole month over such an overlap, so the duplicate must never be created —
 * catching it at publish would just block payroll instead of preventing the
 * double charge.
 */
export function excludeAlreadyDeductedDays(input: {
  bridgeDays: readonly HolidayBridgeDay[];
  /** Employee-days already claimed by any other live candidate, as `${compactHrId}:${date}`. */
  alreadyDeducted: ReadonlySet<string>;
  employeeHrIdCompact: string;
}): HolidayBridgeDay[] {
  return input.bridgeDays.filter(
    (bridge) => !input.alreadyDeducted.has(`${input.employeeHrIdCompact}:${bridge.date}`),
  );
}

/**
 * True when `date` falls before the employee's hire date, so the bridge rule has nothing to charge:
 * he had not joined yet (owner report 2026-11-09 — 18 joiners hired 10 October to 1 November were
 * flagged for 7 and 10 October). Both are ISO `YYYY-MM-DD`; no hire date on record charges as before.
 */
export function isBeforeHireDate(date: string, hireDate: string | null): boolean {
  return Boolean(hireDate) && date < hireDate!;
}
