import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy";

export type AttendanceWorkingWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const attendanceWeekdayOptions: Array<{ label: string; shortLabel: string; value: AttendanceWorkingWeekday }> = [
  { label: "Sunday", shortLabel: "Sun", value: 0 },
  { label: "Monday", shortLabel: "Mon", value: 1 },
  { label: "Tuesday", shortLabel: "Tue", value: 2 },
  { label: "Wednesday", shortLabel: "Wed", value: 3 },
  { label: "Thursday", shortLabel: "Thu", value: 4 },
  { label: "Friday", shortLabel: "Fri", value: 5 },
  { label: "Saturday", shortLabel: "Sat", value: 6 },
];

const allowedWeekdays = new Set<number>(attendanceWeekdayOptions.map((day) => day.value));
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseWeekday(value: unknown): AttendanceWorkingWeekday | null {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || !allowedWeekdays.has(parsed)) return null;
  return parsed as AttendanceWorkingWeekday;
}

export function normalizeAttendanceWorkingWeekdays(value: unknown): AttendanceWorkingWeekday[] | null {
  if (value == null) return null;
  const rawValues = Array.isArray(value)
    ? value
    : String(value)
      .replace(/[{}]/g, "")
      .split(/[,\s]+/)
      .filter(Boolean);
  const weekdays = Array.from(new Set(rawValues.map(parseWeekday).filter((day): day is AttendanceWorkingWeekday => day != null)))
    .sort((left, right) => left - right);
  return weekdays.length > 0 ? weekdays : null;
}

export function weekdayForIsoDate(dateIso: string): AttendanceWorkingWeekday | null {
  if (!isoDatePattern.test(dateIso)) return null;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() as AttendanceWorkingWeekday;
}

export function isAttendanceScheduledWorkingDay(input: {
  dateIso: string;
  jobTitle?: string | null;
  workingWeekdays?: unknown;
}) {
  const weekday = weekdayForIsoDate(input.dateIso);
  if (weekday == null) return false;
  const customWeekdays = normalizeAttendanceWorkingWeekdays(input.workingWeekdays);
  if (customWeekdays) return customWeekdays.includes(weekday);
  return !isFieldWorkforceWeeklyOff({ dateIso: input.dateIso, title: input.jobTitle ?? null });
}

export function formatAttendanceWorkingWeekdays(value: unknown, fallback = "Standard weekend policy") {
  const weekdays = normalizeAttendanceWorkingWeekdays(value);
  if (!weekdays) return fallback;
  const labels = new Map(attendanceWeekdayOptions.map((day) => [day.value, day.shortLabel]));
  return weekdays.map((day) => labels.get(day) ?? String(day)).join(", ");
}
