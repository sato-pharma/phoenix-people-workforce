import type { AccessContext } from "@/lib/auth/permissions";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import {
  employeeExitDay,
  isActiveDirectoryEmployee,
  isWithinNoticePeriod,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import {
  isPrivateCalendarGlobalViewer,
  privateCalendarHrIdKey,
  type PrivateCalendarViewMode,
} from "@/lib/private-calendar/logic";

/**
 * The employees the Private Calendar reads for a window starting on `fromDate`: the active directory,
 * plus anyone still inside a notice period that the window reaches (owner, 2026-10-23: "drop after his
 * resignation date not submission date"). `rows` is the directory read WITH inactive people.
 */
export function privateCalendarRosterFromRows(rows: EmployeeDirectoryRow[], fromDate: string): EmployeeDirectoryRow[] {
  return rows.filter((employee) => isActiveDirectoryEmployee(employee) || isWithinNoticePeriod(employee, fromDate));
}

export type PrivateCalendarPickerStatus = "working" | "left" | "all";

/**
 * Who the admin desk's picker lists for each Status choice. `rows` MUST be the directory read WITH
 * inactive people (`getEmployeeDirectoryRows({ includeInactive: true })`).
 *
 * 🔴 WHY (owner, 2026-11-24: "I CANNOT FIND ESRAA AWAD PRIVATE CALENDAR"). The page read
 * `getEmployeeDirectory()`, whose `employees` are ACTIVE ONLY, so "Left the company" listed
 * "0 employees found of 0" and "Everyone, leavers included" listed the 130 active people and no
 * leaver — the picker could never offer the leaver whose calendar `privateCalendarRosterForRequest`
 * was built to open. A historical payroll record is not a person who left, so it is in no list.
 */
export function privateCalendarPickerPool(
  rows: EmployeeDirectoryRow[],
  status: PrivateCalendarPickerStatus,
): EmployeeDirectoryRow[] {
  const working = (employee: EmployeeDirectoryRow) => isActiveDirectoryEmployee(employee);
  const left = (employee: EmployeeDirectoryRow) => hasDepartedEmployment(employee.employmentStatus);
  if (status === "left") return rows.filter(left);
  if (status === "all") return rows.filter((employee) => working(employee) || left(employee));
  return rows.filter(working);
}

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type PrivateCalendarDeparture = {
  /** "Left on 17 Aug 2026" — the exit day has passed; "Leaving on 30 Nov 2026" — still serving notice. */
  label: string;
  exitDay: string | null;
  upcoming: boolean;
};

/**
 * How the picker names a resignation (owner, 2026-11-24: "I want to see all resignations … historical
 * and upcoming"). Upcoming = the exit day is today or later, so the person is still at work. A departed
 * row with no date at all still reads as departed, never as active. Built from digits, so the server's
 * text and the browser's can never differ.
 */
export function privateCalendarDeparture(
  employee: Pick<EmployeeDirectoryRow, "employmentStatus" | "lastWorkingDate" | "resignationDate">,
  todayIso: string,
): PrivateCalendarDeparture | null {
  const status = String(employee.employmentStatus ?? "").trim().toLowerCase();
  if (!hasDepartedEmployment(status)) return null;
  const exitDay = employeeExitDay(employee);
  const verb = status === "terminated" ? "Terminated" : status === "not_renewed" ? "Not renewed" : "Resigned";
  if (!exitDay) return { exitDay: null, label: verb, upcoming: false };
  const [year, month, day] = exitDay.split("-").map(Number);
  const date = `${day} ${MONTH_ABBREVIATIONS[month - 1]} ${year}`;
  const upcoming = exitDay >= todayIso;
  return { exitDay, label: upcoming ? `Leaving on ${date}` : `${verb} · left on ${date}`, upcoming };
}

/**
 * Newest exits first (upcoming ones at the top), people with no exit date last, then by name — so the
 * Resignations list reads as a timeline instead of an alphabet.
 */
export function compareByExitDayNewestFirst(left: EmployeeDirectoryRow, right: EmployeeDirectoryRow): number {
  const a = employeeExitDay(left) ?? "";
  const b = employeeExitDay(right) ?? "";
  if (a !== b) return a < b ? 1 : -1;
  return left.displayName.localeCompare(right.displayName, "en");
}

/**
 * The month a "View Calendar" link opens for someone who left: the chosen month while it is inside his
 * employment, otherwise the month of his exit day — a month after he left has nothing on it.
 */
export function privateCalendarLinkMonth(
  employee: Pick<EmployeeDirectoryRow, "employmentStatus" | "lastWorkingDate" | "resignationDate">,
  chosen: { month: number; year: number },
): { month: number; year: number } {
  if (!hasDepartedEmployment(employee.employmentStatus)) return chosen;
  const exitDay = employeeExitDay(employee);
  if (!exitDay) return chosen;
  const [year, month] = exitDay.split("-").map(Number);
  if (chosen.year * 12 + chosen.month <= year * 12 + month) return chosen;
  return { month, year };
}

/**
 * The roster ONE person's calendar is read against: the usual roster, plus — for a global viewer who
 * asked for that person by HR id — someone who has already LEFT, whatever month is asked about.
 *
 * 🔴 WHY (owner, 2026-11-24: "i need in private calendars for resignations to be also available for me
 * to see and check if anyone asked about details … even if employee is resigned"). The admin picker
 * already offered leavers ("Everyone, leavers included"), but a leaver whose exit day was before the
 * month asked about fell outside `privateCalendarRosterFromRows`, so opening his calendar threw
 * "Selected employee was not found." and the review requests he had filed could not be read at all.
 *
 * Narrow on purpose: only a private-calendar GLOBAL viewer (the admin desk's own gate), only the person
 * explicitly requested, only the one-person view. The team view, the day-evidence door, the no-activity
 * engine and the deduction reads keep the roster exactly as it was. `isWithinEmploymentWindow` still
 * decides each day, so nothing after the exit day is expected of him.
 */
export function privateCalendarRosterForRequest(input: {
  access: AccessContext;
  allRows: EmployeeDirectoryRow[];
  fromDate: string;
  requestedEmployeeHrId?: string | null;
  viewMode: PrivateCalendarViewMode;
}): EmployeeDirectoryRow[] {
  const roster = privateCalendarRosterFromRows(input.allRows, input.fromDate);
  const requestedKey = privateCalendarHrIdKey(input.requestedEmployeeHrId);
  if (!requestedKey || input.viewMode === "team") return roster;
  if (!isPrivateCalendarGlobalViewer(input.access)) return roster;
  if (roster.some((employee) => privateCalendarHrIdKey(employee.hrId) === requestedKey)) return roster;
  const leaver = input.allRows.find(
    (employee) =>
      privateCalendarHrIdKey(employee.hrId) === requestedKey && hasDepartedEmployment(employee.employmentStatus),
  );
  return leaver ? [...roster, leaver] : roster;
}
