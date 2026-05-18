import { parseDateOnly } from "@/lib/date-only";
import type { HrCalendarEmployee, HrCalendarEvent, HrCalendarEventType } from "@/lib/hr-calendar/types";

const weekendDays = new Set([5, 6]);

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

export function isHrWorkingDay(date: Date, holidays: string[] = []) {
  const dateKey = toHrCalendarDateInputValue(date);
  return !weekendDays.has(date.getDay()) && !holidays.includes(dateKey);
}

export function countHrWorkingDays(dateFrom: string, dateTo: string, holidays: string[] = []) {
  const start = parseDateOnly(dateFrom);
  const end = parseDateOnly(dateTo);
  if (!start || !end || start > end) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    if (isHrWorkingDay(cursor, holidays)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}

export function labelHrCalendarEvent(eventType: HrCalendarEventType, tenureYears: number) {
  if (eventType === "new_hire") return "New hire";
  if (eventType === "birthday") return "Birthday";
  return `${tenureYears} year anniversary`;
}
