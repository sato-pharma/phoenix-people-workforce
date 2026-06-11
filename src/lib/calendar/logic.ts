import type { PhoenixRole } from "@/lib/auth/permissions";

export type CalendarEventCategory =
  | "meeting"
  | "training"
  | "event"
  | "announcement"
  | "deadline"
  | "holiday"
  | "other";

export const calendarEventCategories: readonly CalendarEventCategory[] = [
  "meeting",
  "training",
  "event",
  "announcement",
  "deadline",
  "holiday",
  "other",
];

export type CalendarAudienceScope = "company" | "line";

/** Unified item rendered on the calendar grid (company events + aggregated sources). */
export type CalendarItemSource = "event" | "holiday" | "leave" | "birthday" | "plan";

export type CalendarItem = {
  id: string;
  source: CalendarItemSource;
  title: string;
  startDate: string;
  endDate: string;
  category: CalendarEventCategory;
  time: string | null;
  location: string | null;
  scope: CalendarAudienceScope;
  lineName: string | null;
  description: string | null;
  canManage: boolean;
};

export type CompanyCalendarEventInput = {
  title: string;
  description?: string | null;
  startDate: string;
  endDate?: string | null;
  allDay?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  category?: CalendarEventCategory;
  audienceScope?: CalendarAudienceScope;
  lineName?: string | null;
  location?: string | null;
};

/**
 * Roles allowed to create/edit company calendar events. Plain employees and
 * medical reps are view-only. Admin-tier roles can target the whole company or a
 * specific line; manager-tier roles are constrained to their own line by the
 * service. Kept as an explicit role helper (not the permission matrix) so the
 * all-staff read surface needs no per-role matrix changes.
 */
const CALENDAR_ADMIN_ROLES = new Set<PhoenixRole>(["Super Admin", "HR Specialist", "CEO"]);

const CALENDAR_MANAGER_ROLES = new Set<PhoenixRole>([
  "National Sales Manager",
  "Regional Manager",
  "District Manager",
  "Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "SFE Manager",
  "Finance Manager",
]);

export function canManageCompanyCalendar(role: PhoenixRole): boolean {
  return CALENDAR_ADMIN_ROLES.has(role) || CALENDAR_MANAGER_ROLES.has(role);
}

/** Admin-tier managers may publish company-wide; everyone else is line-scoped. */
export function canPublishCompanyWide(role: PhoenixRole): boolean {
  return CALENDAR_ADMIN_ROLES.has(role);
}

export function normalizeCalendarCategory(value: unknown): CalendarEventCategory {
  const text = String(value ?? "").trim().toLowerCase();
  return (calendarEventCategories as readonly string[]).includes(text)
    ? (text as CalendarEventCategory)
    : "other";
}

/** First and last day (inclusive, ISO) of the given 1-indexed month. */
export function monthBounds(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

/** True when [startA,endA] overlaps [startB,endB] (all inclusive ISO date strings). */
export function rangesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && endA >= startB;
}

export function dateInRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

export type CalendarGridDay = { date: string | null; inMonth: boolean };

/**
 * Build a Sunday-started month grid (always 6 weeks of 7) for the given month.
 * Cells outside the month carry their real date but inMonth=false so the UI can
 * dim them while still resolving events that spill across month edges.
 */
export function buildMonthGrid(year: number, month: number): CalendarGridDay[][] {
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const startOffset = firstOfMonth.getUTCDay(); // 0 = Sunday
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(gridStart.getUTCDate() - startOffset);

  const weeks: CalendarGridDay[][] = [];
  const cursor = new Date(gridStart);
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarGridDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const iso = cursor.toISOString().slice(0, 10);
      days.push({ date: iso, inMonth: cursor.getUTCMonth() === month - 1 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

/** Day/month of an ISO date ignoring the year — for recurring birthdays. */
export function monthDayKey(isoDate: string): string {
  return isoDate.slice(5, 10); // MM-DD
}
