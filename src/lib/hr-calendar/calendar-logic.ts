import { parseDateOnly } from "@/lib/date-only";
import type {
  HrCalendarEmployee,
  HrCalendarEvent,
  HrCalendarEventType,
  HrWeeklyOffMode,
  HrWeeklyOffPolicy,
} from "@/lib/hr-calendar/types";

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

function monthDayDate(sourceDate: Date, selectedYear: number) {
  return new Date(selectedYear, sourceDate.getMonth(), sourceDate.getDate());
}

function dayOfMonth(value: string) {
  return parseDateOnly(value)?.getDate() ?? 0;
}

export function buildHrCalendarEvents(
  employees: HrCalendarEmployee[],
  selectedMonth: number,
  selectedYear: number,
) {
  const events: HrCalendarEvent[] = [];

  for (const employee of employees) {
    const hireDate = parseDateOnly(employee.hireDate);
    const birthDate = parseDateOnly(employee.birthDate);

    if (hireDate && hireDate.getMonth() + 1 === selectedMonth) {
      const hireYear = hireDate.getFullYear();

      if (hireYear === selectedYear) {
        events.push({
          date: employee.hireDate,
          employee,
          eventType: "new_hire",
          tenureYears: 0,
        });
      }

      if (hireYear < selectedYear) {
        events.push({
          date: toHrCalendarDateInputValue(monthDayDate(hireDate, selectedYear)),
          employee,
          eventType: "anniversary",
          tenureYears: selectedYear - hireYear,
        });
      }
    }

    if (birthDate && birthDate.getMonth() + 1 === selectedMonth) {
      events.push({
        date: toHrCalendarDateInputValue(monthDayDate(birthDate, selectedYear)),
        employee,
        eventType: "birthday",
        tenureYears: 0,
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
  if (eventType === "birthday") return "Birthday";
  return `${tenureYears} year anniversary`;
}
