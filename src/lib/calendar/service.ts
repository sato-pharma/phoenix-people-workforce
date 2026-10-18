import { writeAuditLog } from "@/lib/admin/audit";
import { normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { loadManagerPlanHalfDays, managerHalfDayText } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { hrIdForStorage } from "@/lib/hr-id";
import {
  buildMonthGrid,
  canManageCompanyCalendar,
  canPublishCompanyWide,
  monthBounds,
  monthDayKey,
  normalizeCalendarCategory,
  rangesOverlap,
  type CalendarAudienceScope,
  type CalendarGridDay,
  type CalendarItem,
  type CompanyCalendarEventInput,
} from "@/lib/calendar/logic";

const EVENTS_TABLE = "company_calendar_events";

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  start_date: string;
  end_date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  audience_scope: string;
  line_name: string | null;
  created_by_hr_id: string | null;
  created_by_name: string | null;
  created_by_role: string | null;
};

export type CompanyCalendarWorkspace = {
  year: number;
  month: number;
  weeks: CalendarGridDay[][];
  items: CalendarItem[];
  canManage: boolean;
  canPublishCompanyWide: boolean;
  viewerLineName: string | null;
  schemaReady: boolean;
};

function normalizeHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
}

function timeLabel(start: string | null, end: string | null) {
  const parts = [start, end].map((value) => (value ? value.slice(0, 5) : "")).filter(Boolean);
  return parts.length ? parts.join(" - ") : null;
}

function sameLine(a: string | null | undefined, b: string | null | undefined) {
  const left = cleanText(a).toLowerCase();
  const right = cleanText(b).toLowerCase();
  return Boolean(left && right && left === right);
}

function isCalendarSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /company_calendar_events|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

async function viewerLine(access: AccessContext): Promise<string | null> {
  try {
    const rows = await getEmployeeDirectoryRows();
    const viewerHrId = normalizeHrId(access.hrId);
    const row = rows.find((employee) => normalizeHrId(employee.hrId) === viewerHrId);
    return row?.lineName ?? null;
  } catch {
    return null;
  }
}

function mapEventToItem(row: EventRow, access: AccessContext, viewerLineName: string | null): CalendarItem {
  const isAdmin = canPublishCompanyWide(access.role);
  const canManage =
    canManageCompanyCalendar(access.role) &&
    (isAdmin || (row.audience_scope === "line" && sameLine(row.line_name, viewerLineName)));
  return {
    id: row.id,
    source: "event",
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    category: normalizeCalendarCategory(row.category),
    time: row.all_day ? null : timeLabel(row.start_time, row.end_time),
    location: row.location,
    scope: row.audience_scope === "line" ? "line" : "company",
    lineName: row.line_name,
    description: row.description,
    canManage,
  };
}

async function loadCompanyEvents(
  access: AccessContext,
  viewerLineName: string | null,
  start: string,
  end: string,
): Promise<{ items: CalendarItem[]; schemaReady: boolean }> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(EVENTS_TABLE)
      .select("*")
      .lte("start_date", end)
      .gte("end_date", start)
      .order("start_date", { ascending: true })
      .limit(500);
    if (error) throw error;
    const rows = (data ?? []) as EventRow[];
    const visible = rows.filter(
      (row) => row.audience_scope === "company" || sameLine(row.line_name, viewerLineName),
    );
    return { items: visible.map((row) => mapEventToItem(row, access, viewerLineName)), schemaReady: true };
  } catch (error) {
    if (isCalendarSchemaMissing(error)) return { items: [], schemaReady: false };
    throw error;
  }
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<CalendarItem[]> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
    return result.holidays.map((holiday) => ({
      id: `holiday-${holiday.id}`,
      source: "holiday" as const,
      title: holiday.name,
      startDate: holiday.startDate,
      endDate: holiday.endDate ?? holiday.startDate,
      category: "holiday" as const,
      time: null,
      location: null,
      scope: "company" as const,
      lineName: null,
      description: holiday.description,
      canManage: false,
    }));
  } catch {
    return getCompanyHolidaysForMonth({ month, year })
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => ({
        id: `holiday-${holiday.startDate}`,
        source: "holiday" as const,
        title: holiday.name,
        startDate: holiday.startDate,
        endDate: holiday.endDate ?? holiday.startDate,
        category: "holiday" as const,
        time: null,
        location: null,
        scope: "company" as const,
        lineName: null,
        description: null,
        canManage: false,
      }));
  }
}

async function loadLeaveItems(access: AccessContext, start: string, end: string): Promise<CalendarItem[]> {
  const viewerHrId = normalizeHrId(access.hrId);
  if (!viewerHrId) return [];
  const dbHrId = String(access.hrId ?? "").trim().toUpperCase();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      // `vacation_type`, NOT `type` — this table has never had a `type` column. PostgREST fails the
      // WHOLE read on a missing column, and the catch below turns that into an empty list, so from
      // this feature's first commit (2026-06-11) every employee's approved leave was silently absent
      // from their own calendar: 551 approved requests across 92 people, measured on production
      // 2026-09-30. Found by the select-auditor.
      .select("id,employee_hr_id,start_date,end_date,vacation_type,status")
      .eq("employee_hr_id", dbHrId)
      .eq("status", "approved")
      .lte("start_date", end)
      .gte("end_date", start)
      .limit(100);
    if (error) throw error;
    return ((data ?? []) as Array<{ id: string; start_date: string; end_date: string; vacation_type: string | null }>).map(
      (row) => ({
        id: `leave-${row.id}`,
        source: "leave" as const,
        title: `My leave${row.vacation_type ? ` (${row.vacation_type})` : ""}`,
        startDate: row.start_date,
        endDate: row.end_date ?? row.start_date,
        category: "other" as const,
        time: null,
        location: null,
        scope: "company" as const,
        lineName: null,
        description: null,
        canManage: false,
      }),
    );
  } catch {
    return [];
  }
}

async function loadPlanItems(access: AccessContext, start: string, end: string): Promise<CalendarItem[]> {
  const viewerHrId = normalizeHrId(access.hrId);
  if (!viewerHrId) return [];
  const dbHrId = String(access.hrId ?? "").trim().toUpperCase();
  try {
    const supabase = getSupabaseAdmin();
    const { data: headers, error: headerError } = await supabase
      .from("employee_plan_headers")
      .select("id")
      .eq("employee_hr_id", dbHrId)
      // A plan replaced by its approved revision is cancelled, and its rows stay behind — they must not draw beside the revision's.
      .neq("status", "cancelled")
      .limit(50);
    if (headerError) throw headerError;
    const ids = ((headers ?? []) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return [];
    const { data: items, error: itemError } = await supabase
      .from("employee_plan_items")
      .select("id,activity_date,activity_title,activity_type")
      .in("plan_id", ids)
      .gte("activity_date", start)
      .lte("activity_date", end)
      .limit(200);
    if (itemError) throw itemError;
    return ((items ?? []) as Array<{ id: string; activity_date: string; activity_title: string | null; activity_type: string | null }>).map((row) => ({
      id: `plan-${row.id}`,
      source: "plan" as const,
      title: `Plan: ${row.activity_title || row.activity_type || "Activity"}`,
      startDate: row.activity_date,
      endDate: row.activity_date,
      category: "other" as const,
      time: null,
      location: null,
      scope: "company" as const,
      lineName: null,
      description: null,
      canManage: false,
    }));
  } catch {
    return [];
  }
}

/**
 * His own Phoenix CRM weekly plan, half-day by half-day — a district manager's week REPLACES his legacy
 * plan once his team is live (owner, 2026-10-16), so his calendar keeps showing what he planned. His own
 * items only, like the legacy read above.
 */
async function loadManagerPlanItems(access: AccessContext, start: string, end: string): Promise<CalendarItem[]> {
  const viewerHrId = normalizeHrId(access.hrId);
  if (!viewerHrId) return [];
  try {
    const halfDays = await loadManagerPlanHalfDays({ from: start, to: end, managerHrIds: [String(access.hrId)], sentOnly: false });
    if (halfDays.length === 0) return [];
    const names = await loadPeopleNames(halfDays.map((halfDay) => halfDay.repHrId));
    return halfDays.map((halfDay) => ({
      id: `crm-plan-${halfDay.slotId}`,
      source: "plan" as const,
      title: `Plan: ${halfDay.half} · ${managerHalfDayText(halfDay, halfDay.repHrId ? nameOf(names, halfDay.repHrId, "a rep") : null)}`,
      startDate: halfDay.date,
      endDate: halfDay.date,
      category: "other" as const,
      time: null,
      location: null,
      scope: "company" as const,
      lineName: null,
      description: null,
      canManage: false,
    }));
  } catch {
    return [];
  }
}

async function loadBirthdayItems(access: AccessContext, viewerLineName: string | null, year: number, month: number): Promise<CalendarItem[]> {
  if (!viewerLineName) return [];
  try {
    const rows = await getEmployeeDirectoryRows();
    const viewerHrId = normalizeHrId(access.hrId);
    const monthPrefix = String(month).padStart(2, "0");
    return rows
      .filter((row) => row.birthDate && sameLine(row.lineName, viewerLineName))
      .filter((row) => monthDayKey(row.birthDate as string).slice(0, 2) === monthPrefix)
      .map((row) => {
        const isSelf = normalizeHrId(row.hrId) === viewerHrId;
        const dayOfMonth = monthDayKey(row.birthDate as string).slice(3, 5);
        const date = `${year}-${monthPrefix}-${dayOfMonth}`;
        return {
          id: `birthday-${row.hrId}`,
          source: "birthday" as const,
          title: isSelf ? "My birthday 🎂" : `${row.displayName}'s birthday 🎂`,
          startDate: date,
          endDate: date,
          category: "event" as const,
          time: null,
          location: null,
          scope: "line" as const,
          lineName: viewerLineName,
          description: null,
          canManage: false,
        };
      });
  } catch {
    return [];
  }
}

export async function getCompanyCalendarWorkspace(
  access: AccessContext,
  year: number,
  month: number,
): Promise<CompanyCalendarWorkspace> {
  if (access.source === "guest") {
    throw new Error("Forbidden: you must be signed in to view the calendar.");
  }
  const { start, end } = monthBounds(year, month);
  const viewerLineName = await viewerLine(access);

  const [eventsResult, holidays, leave, plans, crmPlans, birthdays] = await Promise.all([
    loadCompanyEvents(access, viewerLineName, start, end),
    loadHolidayItems(year, month, start, end),
    loadLeaveItems(access, start, end),
    loadPlanItems(access, start, end),
    loadManagerPlanItems(access, start, end),
    loadBirthdayItems(access, viewerLineName, year, month),
  ]);

  const items = [...eventsResult.items, ...holidays, ...leave, ...plans, ...crmPlans, ...birthdays].sort((a, b) =>
    `${a.startDate}-${a.title}`.localeCompare(`${b.startDate}-${b.title}`),
  );

  return {
    year,
    month,
    weeks: buildMonthGrid(year, month),
    items,
    canManage: canManageCompanyCalendar(access.role),
    canPublishCompanyWide: canPublishCompanyWide(access.role),
    viewerLineName,
    schemaReady: eventsResult.schemaReady,
  };
}

function assertCanManage(access: AccessContext) {
  if (!canManageCompanyCalendar(access.role)) {
    throw new Error("Forbidden: you are not allowed to manage calendar events.");
  }
}

async function resolveScope(
  access: AccessContext,
  input: CompanyCalendarEventInput,
): Promise<{ audienceScope: CalendarAudienceScope; lineName: string | null }> {
  const wantsCompany = (input.audienceScope ?? "company") === "company";
  if (canPublishCompanyWide(access.role) && wantsCompany) {
    return { audienceScope: "company", lineName: null };
  }
  // Line-scoped: admins may target a chosen line; managers are locked to their own.
  const lineName = canPublishCompanyWide(access.role)
    ? nullableText(input.lineName) ?? (await viewerLine(access))
    : await viewerLine(access);
  if (!lineName) {
    throw new Error("A line is required for a team event, but your profile has no line set. Contact HR.");
  }
  return { audienceScope: "line", lineName };
}

function normalizeEventInput(input: CompanyCalendarEventInput) {
  const title = cleanText(input.title);
  if (!title) throw new Error("Event title is required.");
  const startDate = cleanText(input.startDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("A valid start date is required.");
  const endDate = cleanText(input.endDate) || startDate;
  if (endDate < startDate) throw new Error("End date cannot be before the start date.");
  const allDay = input.allDay !== false;
  return {
    title,
    description: nullableText(input.description),
    category: normalizeCalendarCategory(input.category),
    startDate,
    endDate,
    allDay,
    startTime: allDay ? null : nullableText(input.startTime),
    endTime: allDay ? null : nullableText(input.endTime),
    location: nullableText(input.location),
  };
}

export async function createCompanyCalendarEvent(access: AccessContext, input: CompanyCalendarEventInput) {
  assertCanManage(access);
  const normalized = normalizeEventInput(input);
  const scope = await resolveScope(access, input);
  const { data, error } = await getSupabaseAdmin()
    .from(EVENTS_TABLE)
    .insert({
      title: normalized.title,
      description: normalized.description,
      category: normalized.category,
      start_date: normalized.startDate,
      end_date: normalized.endDate,
      all_day: normalized.allDay,
      start_time: normalized.startTime,
      end_time: normalized.endTime,
      location: normalized.location,
      audience_scope: scope.audienceScope,
      line_name: scope.lineName,
      created_by_hr_id: hrIdForStorage(access.hrId),
      created_by_name: null,
      created_by_role: access.role,
    })
    .select("id")
    .single();
  if (error) throw error;
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: String(data?.id ?? ""),
    entityType: "calendar_event",
    newValues: { scope: scope.audienceScope, category: normalized.category },
    summary: `Calendar event created: ${normalized.title}`,
  });
  return { id: String(data?.id ?? "") };
}

async function loadEventForManage(access: AccessContext, id: string): Promise<EventRow> {
  const { data, error } = await getSupabaseAdmin().from(EVENTS_TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Calendar event was not found.");
  const row = data as EventRow;
  const isAdmin = canPublishCompanyWide(access.role);
  if (!canManageCompanyCalendar(access.role)) {
    throw new Error("Forbidden: you are not allowed to manage calendar events.");
  }
  if (!isAdmin) {
    const viewerLineName = await viewerLine(access);
    if (row.audience_scope !== "line" || !sameLine(row.line_name, viewerLineName)) {
      throw new Error("Forbidden: you can only manage events for your own team line.");
    }
  }
  return row;
}

export async function updateCompanyCalendarEvent(
  access: AccessContext,
  id: string,
  input: CompanyCalendarEventInput,
) {
  await loadEventForManage(access, id);
  const normalized = normalizeEventInput(input);
  const scope = await resolveScope(access, input);
  const { error } = await getSupabaseAdmin()
    .from(EVENTS_TABLE)
    .update({
      title: normalized.title,
      description: normalized.description,
      category: normalized.category,
      start_date: normalized.startDate,
      end_date: normalized.endDate,
      all_day: normalized.allDay,
      start_time: normalized.startTime,
      end_time: normalized.endTime,
      location: normalized.location,
      audience_scope: scope.audienceScope,
      line_name: scope.lineName,
    })
    .eq("id", id);
  if (error) throw error;
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: id,
    entityType: "calendar_event",
    newValues: { scope: scope.audienceScope, category: normalized.category },
    summary: `Calendar event updated: ${normalized.title}`,
  });
  return { id };
}

export async function deleteCompanyCalendarEvent(access: AccessContext, id: string) {
  await loadEventForManage(access, id);
  const { error } = await getSupabaseAdmin().from(EVENTS_TABLE).delete().eq("id", id);
  if (error) throw error;
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: id,
    entityType: "calendar_event",
    summary: "Calendar event deleted",
  });
  return { id };
}
