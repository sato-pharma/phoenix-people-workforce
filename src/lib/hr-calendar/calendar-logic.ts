import { parseDateOnly } from "@/lib/date-only";
import type {
  HrCalendarEmployee,
  HrCalendarEvent,
  HrCalendarEventType,
  HrWeeklyOffMode,
  HrWeeklyOffPolicy,
} from "@/lib/hr-calendar/types";
import {
  birthdaySpec,
  calendarMilestoneSpecs,
  firstSatoBirthday,
  formatMilestoneSpec,
  formatPlainDateIso,
  milestoneDate,
  monthDayOf,
  monthDayOn,
  parsePlainDate,
  satoBirthdayOrdinal,
} from "@/lib/milestones/periods";

export const defaultHrWeeklyOffPolicy: HrWeeklyOffPolicy = {
  friday: "full_day",
  saturday: "working",
  thursday: "working",
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toHrCalendarDateInputValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayOfMonth(value: string) {
  return parseDateOnly(value)?.getDate() ?? 0;
}

/**
 * The events that fall in one calendar month.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DATED BY THE MILESTONE ARITHMETIC, WHICH CLAMPS. The old code dated an anniversary and a birthday
 * with `new Date(year, month, day)`, which ROLLS OVER — a 29-February date became 1 March in a
 * common year, so leap-day staff matched no day of the month and were never notified. Every date
 * here now comes from `milestoneDate` / `monthDayOn`, which clamp 29 February to 28 February, so the
 * calendar and the printed card agree to the day and leap-day staff are marked on the 28th.
 *
 * "First month and then yearly" (the owner, 2026-09-23): the printable ladder is `calendarMilestoneSpecs`
 * — the first month, then every year to 60. `spec` carries the period each row prints as, or null for
 * a row that has no card (a plain arrival, or a birthday/anniversary with no usable date).
 */
export function buildHrCalendarEvents(
  employees: HrCalendarEmployee[],
  selectedMonth: number,
  selectedYear: number,
) {
  const events: HrCalendarEvent[] = [];

  for (const employee of employees) {
    const hire = parsePlainDate(employee.hireDate);

    if (hire) {
      // The arrival itself — its own day, its own year, and it prints no card.
      if (hire.year === selectedYear && hire.month === selectedMonth) {
        events.push({
          date: employee.hireDate,
          employee,
          eventType: "new_hire",
          tenureYears: 0,
          spec: null,
        });
      }

      // The first month, then every year. Each spec is dated arithmetically; only the one that
      // lands in this month and year is shown, and it carries the period it prints as.
      for (const spec of calendarMilestoneSpecs(hire, selectedYear)) {
        const on = milestoneDate(hire, spec);
        if (on.year !== selectedYear || on.month !== selectedMonth) continue;
        events.push({
          date: formatPlainDateIso(on),
          employee,
          eventType: spec.unit === "month" ? "first_month" : "anniversary",
          tenureYears: spec.unit === "year" ? spec.count : 0,
          spec: formatMilestoneSpec(spec),
        });
      }
    }

    // The birthday — every year, CLAMPED. It prints as `b<ordinal>` when the hire date lets us count
    // which Sato-Pharma birthday it is; without a hire date the row shows but carries no card.
    const birthday = monthDayOf(employee.birthDate);
    if (birthday && birthday.month === selectedMonth) {
      const on = monthDayOn(birthday, selectedYear);
      let spec: string | null = null;
      if (hire) {
        const ordinal = satoBirthdayOrdinal(on, firstSatoBirthday(hire, birthday));
        if (ordinal >= 1) spec = birthdaySpec(ordinal);
      }
      events.push({
        date: formatPlainDateIso(on),
        employee,
        eventType: "birthday",
        tenureYears: 0,
        spec,
      });
    }
  }

  return events.sort((left, right) => {
    const dayDiff = dayOfMonth(left.date) - dayOfMonth(right.date);
    if (dayDiff !== 0) return dayDiff;
    return left.employee.fullName.localeCompare(right.employee.fullName);
  });
}

export function buildHrCalendarDays(selectedMonth: number, selectedYear: number) {
  const firstDay = new Date(selectedYear, selectedMonth - 1, 1);
  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const leadingEmptyDays = firstDay.getDay();
  const cells: Array<Date | null> = [];

  for (let index = 0; index < leadingEmptyDays; index += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(selectedYear, selectedMonth - 1, day));
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return cells;
}

export function summarizeHrCalendarEvents(events: HrCalendarEvent[]) {
  return {
    anniversaries: events.filter((event) => event.eventType === "anniversary").length,
    birthdays: events.filter((event) => event.eventType === "birthday").length,
    newHires: events.filter((event) => event.eventType === "new_hire").length,
    totalEvents: events.length,
  };
}

function normalizedWeeklyOffPolicy(policy?: Partial<HrWeeklyOffPolicy> | null): HrWeeklyOffPolicy {
  return {
    friday: policy?.friday ?? defaultHrWeeklyOffPolicy.friday,
    saturday: policy?.saturday ?? defaultHrWeeklyOffPolicy.saturday,
    thursday: policy?.thursday ?? defaultHrWeeklyOffPolicy.thursday,
  };
}

export function getHrWeeklyOffMode(date: Date, policy?: Partial<HrWeeklyOffPolicy> | null): HrWeeklyOffMode {
  const normalized = normalizedWeeklyOffPolicy(policy);
  if (date.getDay() === 4) return normalized.thursday;
  if (date.getDay() === 5) return normalized.friday;
  if (date.getDay() === 6) return normalized.saturday;
  return "working";
}

export function getHrWorkingDayFraction(date: Date, holidays: string[] = [], policy?: Partial<HrWeeklyOffPolicy> | null) {
  const dateKey = toHrCalendarDateInputValue(date);
  if (holidays.includes(dateKey)) return 0;

  const weeklyOffMode = getHrWeeklyOffMode(date, policy);
  if (weeklyOffMode === "full_day") return 0;
  if (weeklyOffMode === "am_only" || weeklyOffMode === "pm_only") return 0.5;
  return 1;
}

export function isHrWorkingDay(date: Date, holidays: string[] = [], policy?: Partial<HrWeeklyOffPolicy> | null) {
  return getHrWorkingDayFraction(date, holidays, policy) > 0;
}

export function isHrWorkingDayPart(
  date: Date,
  dayPart: "am_only" | "pm_only",
  holidays: string[] = [],
  policy?: Partial<HrWeeklyOffPolicy> | null,
) {
  const dateKey = toHrCalendarDateInputValue(date);
  if (holidays.includes(dateKey)) return false;

  const weeklyOffMode = getHrWeeklyOffMode(date, policy);
  if (weeklyOffMode === "full_day") return false;
  if (weeklyOffMode === dayPart) return false;
  return true;
}

export function countHrWorkingDays(
  dateFrom: string,
  dateTo: string,
  holidays: string[] = [],
  policy?: Partial<HrWeeklyOffPolicy> | null,
) {
  const start = parseDateOnly(dateFrom);
  const end = parseDateOnly(dateTo);
  if (!start || !end || start > end) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    count += getHrWorkingDayFraction(cursor, holidays, policy);
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}

export function labelHrCalendarEvent(eventType: HrCalendarEventType, tenureYears: number) {
  if (eventType === "new_hire") return "New hire";
  if (eventType === "first_month") return "First month";
  if (eventType === "birthday") return "Birthday";
  return `${tenureYears} year anniversary`;
}
