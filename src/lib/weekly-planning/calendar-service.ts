import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, hrIdsMatch, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { activeRoleSignIns } from "@/lib/employees/role-lookup";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoDateKey } from "@/lib/activity/working-baseline";
import { loadManagerPlanHalfDays, loadManagerVisitAreas, managerHalfDayText, managerPlanLegacyStatus } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import type { EmployeePlanActivityType, EmployeePlanKind, EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";
import {
  activityDisplayLabel,
  attachPlanningConflictWarnings,
  buildPlaceEvidence,
  buildPlanningCalendarConflicts,
  planningCalendarTitle,
  planningConflictKey,
  placeEvidenceKey,
  planSlotLabel,
  buildAreaRegionIndex,
  regionOfArea,
  resolvePlanItemArea,
  planItemStoredRegion,
  resolvePlanItemRegion,
  sharedPlanningCalendarStatuses,
  mergeFullDayPlanItems,
  withoutOfficeDays,
  type PlanningCalendarHolidayItem,
  type PlanningCalendarPlanItem,
  type PlanningCalendarWorkspace,
  sameLineBookingRangeProblem,
  type SameLinePlanBooking,
} from "@/lib/weekly-planning/calendar";
import { dropPendingRevisionsOfPlansOfRecord } from "@/lib/weekly-planning/plan-revisions";

const CALENDAR_HEADER_LIMIT = 1000;
const CALENDAR_ITEM_LIMIT = 5000;

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const ALLOWED_CALENDAR_OWNER_ROLES = new Set([
  "national sales manager",
  "product manager",
  "group product manager",
  "territory manager",
  "training manager",
  "marketing manager",
  "district manager",
  "district sales manager",
  // Regional / Regional Sales Manager: an RM is a plan SUBMITTER (see
  // WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES in weekly-planning/plan-v1.ts), so their own plan must be
  // able to appear on the shared Planning Calendar. Omitting them here meant an RM's submitted plan
  // was invisible to every viewer — including the RM themselves and their approving NSM.
  "regional manager",
  "regional sales manager",
]);

type PlanCalendarHeaderRow = {
  employee_hr_id: string;
  employee_job_title: string | null;
  employee_name: string;
  id: string;
  parent_plan_id: string | null;
  period_end_date: string;
  period_start_date: string;
  plan_kind: EmployeePlanKind;
  status: EmployeePlanStatus;
};

type PlanCalendarItemRow = {
  activity_date: string;
  activity_title: string;
  activity_type: EmployeePlanActivityType;
  area: string | null;
  double_visit_medical_rep_hr_id: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string | null;
  plan_id: string;
  sort_order: number | null;
  start_time: string | null;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeLowerText(value: string | null | undefined) {
  return cleanText(value).toLowerCase();
}

function normalizeHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function isHeadOfficeLine(lineName: string | null | undefined) {
  const normalized = normalizeLowerText(lineName).replace(/[^a-z0-9]/g, "");
  return ["office", "headoffice", "hq"].includes(normalized);
}

function isAllowedCalendarOwnerTitle(employeeJobTitle: string | null) {
  const role = normalizeLowerText(employeeJobTitle);
  if (!role) return false;
  if ([...ALLOWED_CALENDAR_OWNER_ROLES].some((allowedRole) => role.includes(allowedRole))) return true;
  const tokens = role.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const aliases = new Set(["nsm", "pm", "gpm", "tm", "dsm"]);
  if (tokens.some((token) => aliases.has(token))) return true;
  const hasManager = tokens.includes("manager");
  const hasTerritory = tokens.includes("territory");
  return hasManager && hasTerritory;
}

function isAllowedCalendarOwner(item: PlanningCalendarPlanItem, viewer: CalendarViewerContext) {
  if (isHeadOfficeLine(item.lineName)) return true;
  const title = normalizeLowerText(item.employeeJobTitle);
  if (ALLOWED_CALENDAR_OWNER_ROLES.has(title) || isAllowedCalendarOwnerTitle(item.employeeJobTitle)) return true;
  // An acting District Manager keeps a Medical Representative title, so the title test above dropped
  // her plans from every viewer's calendar — her own Regional and National Manager included. Her
  // District Manager APP role makes her an owner too (owner, 2026-10-20: every role that applies must
  // appear; isDistrictManagerPlanSubmitter reads the same pair). A viewer context built without the
  // set keeps the title-only answer.
  return Boolean(viewer.districtManagerHrIds?.has(normalizeHrId(item.employeeHrId)));
}

function sameLine(left: string | null | undefined, right: string | null | undefined) {
  const a = cleanText(left).toLowerCase();
  const b = cleanText(right).toLowerCase();
  return Boolean(a && b && a === b);
}

function itemHasJobTitle(item: PlanningCalendarPlanItem, needle: string) {
  return normalizeLowerText(item.employeeJobTitle).includes(needle);
}

// Exact match, not substring — "product manager" is a substring of "group product
// manager", so a plain .includes() check would wrongly also match GPM items. Only
// needed where a rule must grant Product Manager but deliberately NOT Group Product
// Manager (District/Regional Manager below); everywhere else itemHasJobTitle's
// substring match is intentional (e.g. matching "group product manager" is safe
// since no other title contains that longer string).
function itemIsExactlyProductManager(item: PlanningCalendarPlanItem) {
  return normalizeLowerText(item.employeeJobTitle) === "product manager";
}

function itemHasLine(item: PlanningCalendarPlanItem, lineName: string | null) {
  return sameLine(item.lineName, lineName);
}

function itemReportsToViewer(item: PlanningCalendarPlanItem, viewer: CalendarViewerContext) {
  return viewer.directReportHrIds.has(normalizeHrId(item.employeeHrId));
}

const PEDIA_LINE = "Pedia";
const ANTI_INFECTIVE_LINE = "Anti Infective";
const CNS_LINE = "CNS";

// B-155 (Ahmed Sharaf Eldeen) is the Product Manager for a named set of cross-line products
// spanning Pedia + Anti Infective, not a generic "two-line PM" — see
// PRODUCT_SCOPE_EXCLUSIVE_HR_IDS in marketing-requests/service.ts for the same
// named-exception pattern applied to this one person's sales/marketing scope. The products
// themselves live in app_auth_users.product_scope_override (four codes since 2026-09-28); this
// calendar rule is deliberately line-shaped and does not read them.
const AHMED_SHARAF_HR_ID = "B-155";

export type CalendarViewerContext = {
  hrId: string;
  role: string | null;
  lineName: string | null;
  // Normalized (normalizeHrIdForAccess) HR_IDs of employees whose managerHrId
  // resolves to this viewer — i.e. who reports to them. Only District/Regional
  // Manager rules currently use this; computed for every viewer regardless since
  // it's a cheap filter over the already-loaded directory.
  directReportHrIds: ReadonlySet<string>;
  // Normalized HR_IDs of every active District Manager APP role holder (app_auth_users), so a plan
  // owner whose title is still a rep's — an acting District Manager — is still a calendar owner.
  // Optional: left out, ownership is decided by title alone, as it was before.
  districtManagerHrIds?: ReadonlySet<string>;
};

// Role/line-scoped visibility (owner decision 2026-07-20, refined twice same-day —
// supersedes the unconditional cross-line/cross-hierarchy visibility from owner
// decision 2026-07-19; this is a fresh, more specific rule set, not a plain revert):
//   - CEO / Super Admin: unrestricted, see every calendar-eligible plan.
//   - Training Manager: unrestricted, see every calendar-eligible plan.
//   - Marketing Manager: Training Manager's plans + every Product Manager's and
//     Group Product Manager's plans, company-wide (not line-scoped — Marketing
//     Manager has no line of their own to scope to).
//   - B-155 (Ahmed Sharaf): Pedia plans + Anti Infective plans + Training Manager's plans.
//   - Group Product Manager on the Pedia line: Training Manager's plans + all Pedia plans.
//   - National Sales Manager on the Pedia line: the Group Product Manager's plans + all Pedia plans.
//   - National Sales Manager on the Anti Infective line: Training Manager's plans + all Anti Infective plans.
//   - National Sales Manager on the CNS line: Training Manager's plans + all CNS plans (owner,
//     2026-09-20: the CNS NSM was the one NSM left on the unrestricted default, so he saw every
//     line's managers while the other two saw only their own).
//   - Product Manager on the Anti Infective line: Training Manager's plans + all Anti Infective plans.
//   - District Manager: Training Manager's plans + their OWN line's Product Manager's plans
//     only — never other lines, never their own line's NSM, never other District Managers
//     (including peers, and their own submission — this is a coordination view, not "my plan").
//   - Regional Manager: same shape as District Manager (Training Manager + own-line Product
//     Manager), PLUS their own line's Group Product Manager, PLUS the plans of the District
//     Managers who report directly to them (not every District Manager on their line).
//   - Talent Acquisition: unrestricted, same as Training Manager — she is a Head Office
//     role serving all 3 sales lines (owner decision 2026-07-25), not a role confined to
//     Head-Office-only scheduling. A same-day narrower rule (Head-Office-line plans plus
//     one named PM exception) was reverted the same day once that concept was clarified.
//   - Anyone else with calendar access (any role/line not named above) keeps the
//     unrestricted default — only the roles above were narrowed.
export function isPlanItemVisibleToViewer(item: PlanningCalendarPlanItem, viewer: CalendarViewerContext): boolean {
  if (!isAllowedCalendarOwner(item, viewer)) return false;
  // The person a district manager picked for a half-day with him always sees it (owner, 2026-10-24) — the
  // CNS Marketing Manager, for one, is otherwise shown no district manager's plan at all.
  if (item.withHrId && hrIdsMatch(item.withHrId, viewer.hrId)) return true;

  const role = normalizeLowerText(viewer.role);
  if (role === "ceo" || role === "super admin") return true;
  if (role === "training manager") return true;
  if (role === "marketing manager") {
    // "product manager" is a substring of "group product manager", so this
    // single check intentionally covers both titles — no exact-match helper
    // needed here, unlike the District/Regional Manager rules below which must
    // exclude Group Product Manager specifically.
    return itemHasJobTitle(item, "training manager") || itemHasJobTitle(item, "product manager");
  }

  if (hrIdsMatch(viewer.hrId, AHMED_SHARAF_HR_ID)) {
    return itemHasLine(item, PEDIA_LINE) || itemHasLine(item, ANTI_INFECTIVE_LINE) || itemHasJobTitle(item, "training manager");
  }

  if (role === "group product manager" && sameLine(viewer.lineName, PEDIA_LINE)) {
    return itemHasJobTitle(item, "training manager") || itemHasLine(item, PEDIA_LINE);
  }
  if (role === "national sales manager" && sameLine(viewer.lineName, PEDIA_LINE)) {
    return itemHasJobTitle(item, "group product manager") || itemHasLine(item, PEDIA_LINE);
  }
  if (role === "national sales manager" && sameLine(viewer.lineName, ANTI_INFECTIVE_LINE)) {
    return itemHasJobTitle(item, "training manager") || itemHasLine(item, ANTI_INFECTIVE_LINE);
  }
  if (role === "national sales manager" && sameLine(viewer.lineName, CNS_LINE)) {
    return itemHasJobTitle(item, "training manager") || itemHasLine(item, CNS_LINE);
  }
  if (role === "product manager" && sameLine(viewer.lineName, ANTI_INFECTIVE_LINE)) {
    return itemHasJobTitle(item, "training manager") || itemHasLine(item, ANTI_INFECTIVE_LINE);
  }

  if (role === "district manager") {
    return itemHasJobTitle(item, "training manager") || (itemIsExactlyProductManager(item) && itemHasLine(item, viewer.lineName));
  }
  if (role === "regional manager") {
    return (
      itemHasJobTitle(item, "training manager") ||
      (itemHasLine(item, viewer.lineName) && (itemIsExactlyProductManager(item) || itemHasJobTitle(item, "group product manager"))) ||
      itemReportsToViewer(item, viewer)
    );
  }
  return true;
}

function isPlanningSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<PlanningCalendarHolidayItem[]> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
    return result.holidays
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => ({
        description: holiday.description,
        endDate: holiday.endDate ?? holiday.startDate,
        id: `holiday-${holiday.id}`,
        source: "holiday" as const,
        startDate: holiday.startDate,
        title: holiday.name,
      }));
  } catch {
    return getCompanyHolidaysForMonth({ month, year })
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => ({
        description: null,
        endDate: holiday.endDate ?? holiday.startDate,
        id: `holiday-${holiday.startDate}`,
        source: "holiday" as const,
        startDate: holiday.startDate,
        title: holiday.name,
      }));
  }
}

/**
 * Where people actually were in the window (owner, 2026-10-24: "check his CRM visits or his expenses,
 * where was he"): the area of the customers a manager visited in Phoenix CRM, and the area on an expense
 * trip that is not rejected. It only fills an area nothing else names, so a failed read leaves the
 * calendar as it was rather than failing the month.
 */
async function loadPlaceEvidence(start: string, end: string): Promise<Map<string, string>> {
  try {
    const supabase = getSupabaseAdmin();
    const [visits, claims] = await Promise.all([
      loadManagerVisitAreas({ end, start }),
      // Paged: a fixed cap would drop the later trips, and their days would lose the place they were spent in.
      fetchAllRows<{ area_name: string | null; employee_hr_id: string; trip_end_date: string | null; trip_start_date: string | null }>(
        () =>
          supabase
            .from("expense_claims")
            .select("employee_hr_id,trip_start_date,trip_end_date,area_name")
            .lte("trip_start_date", `${end}T23:59:59Z`)
            .gte("trip_end_date", `${start}T00:00:00Z`)
            .neq("status", "rejected")
            .not("area_name", "is", null),
        "id",
      ),
    ]);
    return buildPlaceEvidence(
      visits,
      claims.flatMap((row) => {
        const startDate = cairoDateKey(row.trip_start_date);
        const endDate = cairoDateKey(row.trip_end_date) ?? startDate;
        return startDate && endDate ? [{ areaName: row.area_name, endDate, hrId: row.employee_hr_id, startDate }] : [];
      }),
    );
  } catch (error) {
    console.warn("planning calendar: place evidence unavailable", error instanceof Error ? error.message : error);
    return new Map();
  }
}

/** The legacy plans' items and the district managers' Phoenix CRM half-days, read side by side. */
async function loadSubmittedPlanItems(start: string, end: string): ReturnType<typeof loadLegacySubmittedPlanItems> {
  const [legacy, halfDays] = await Promise.all([loadLegacySubmittedPlanItems(start, end), readManagerPlanHalfDays(start, end)]);
  return { ...legacy, items: [...legacy.items, ...managerPlanCalendarItems(halfDays, legacy.directoryByHrId, legacy.placeEvidence, legacy.areaRegions)] };
}

async function loadLegacySubmittedPlanItems(start: string, end: string): Promise<{
  areaRegions: Map<string, string>;
  directoryByHrId: Map<string, EmployeeDirectoryRow>;
  hasMoreHeaders: boolean;
  hasMoreItems: boolean;
  items: PlanningCalendarPlanItem[];
  loadedHeaderCount: number;
  loadedItemCount: number;
  placeEvidence: Map<string, string>;
}> {
  const supabase = getSupabaseAdmin();
  const [directoryRows, placeEvidence, headersResult] = await Promise.all([
    getEmployeeDirectoryRows(),
    loadPlaceEvidence(start, end),
    supabase
      .from("employee_plan_headers")
      .select("id,employee_hr_id,employee_name,employee_job_title,plan_kind,status,period_start_date,period_end_date,parent_plan_id")
      .in("status", [...sharedPlanningCalendarStatuses])
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .order("period_start_date", { ascending: true })
      .limit(CALENDAR_HEADER_LIMIT + 1),
  ]);
  if (headersResult.error) throw headersResult.error;

  const loadedHeaders = (headersResult.data ?? []) as PlanCalendarHeaderRow[];
  const hasMoreHeaders = loadedHeaders.length > CALENDAR_HEADER_LIMIT;
  // The approved plan stays on the calendar while its revision waits for a decision; the revision
  // is left out until it is approved, or the week would be drawn twice (the B-122 symptom).
  const headers = dropPendingRevisionsOfPlansOfRecord(loadedHeaders.slice(0, CALENDAR_HEADER_LIMIT));
  const headerById = new Map(headers.map((header) => [header.id, header]));
  const planIds = headers.map((header) => header.id);
  const directoryByHrId = new Map(directoryRows.map((row) => [normalizeHrId(row.hrId), row]));
  const areaRegions = buildAreaRegionIndex(directoryRows);
  if (planIds.length === 0) {
    return {
      areaRegions,
      directoryByHrId,
      hasMoreHeaders,
      hasMoreItems: false,
      items: [],
      loadedHeaderCount: headers.length,
      loadedItemCount: 0,
      placeEvidence,
    };
  }

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — planIds can reach CALENDAR_HEADER_LIMIT (1000), so batch it.
  const loadedRows: PlanCalendarItemRow[] = [];
  for (const planIdBatch of chunk(planIds, 100)) {
    const { data: rawRows, error } = await supabase
      .from("employee_plan_items")
      .select("id,plan_id,activity_date,start_time,end_time,activity_type,activity_title,location_text,area,double_visit_medical_rep_hr_id,double_visit_medical_rep_name,notes,sort_order")
      .in("plan_id", planIdBatch)
      .gte("activity_date", start)
      .lte("activity_date", end)
      .order("activity_date", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(CALENDAR_ITEM_LIMIT + 1);
    if (error) throw error;
    loadedRows.push(...((rawRows ?? []) as PlanCalendarItemRow[]));
  }
  loadedRows.sort((left, right) => left.activity_date.localeCompare(right.activity_date) || (left.sort_order ?? 0) - (right.sort_order ?? 0));
  const hasMoreItems = loadedRows.length > CALENDAR_ITEM_LIMIT;
  const rows = loadedRows.slice(0, CALENDAR_ITEM_LIMIT);

  const items = rows.flatMap((row) => {
    const header = headerById.get(row.plan_id);
    if (!header) return [];
    // directoryByHrId only contains active, organogram-visible employees (see
    // getEmployeeDirectoryRows' default includeInactive:false) — a plan owner
    // who has since resigned/been terminated won't be in it. Drop their rows
    // entirely rather than falling back to the raw stored name, so a shared
    // calendar of "who's doing what" stops surfacing people who no longer work
    // here, regardless of how far in the past or future the plan period is.
    const employee = directoryByHrId.get(normalizeHrId(header.employee_hr_id));
    if (!employee) return [];
    const lineName = employee?.lineName ?? null;
    const activityTitle = activityDisplayLabel(row.activity_type, row.activity_title);
    const medicalRepHrId = cleanText(row.double_visit_medical_rep_hr_id) || null;
    const medicalRepName = cleanText(row.double_visit_medical_rep_name) || null;
    const medicalRepEmployee = medicalRepHrId ? directoryByHrId.get(normalizeHrId(medicalRepHrId)) : undefined;
    const medicalRepDisplayName = medicalRepEmployee?.displayName || medicalRepName;
    const area = resolvePlanItemArea(row.area, medicalRepEmployee?.areaName, employee.areaName, placeEvidence.get(placeEvidenceKey(header.employee_hr_id, row.activity_date)));
    const region = resolvePlanItemRegion(planItemStoredRegion(row.activity_type, row.location_text), medicalRepEmployee?.regionName, employee.regionName, regionOfArea(areaRegions, area));
    const conflictKey = planningConflictKey(row.activity_date, lineName, medicalRepHrId ?? medicalRepName);
    const employeeDisplayName = employee?.displayName || header.employee_name;
    const item: PlanningCalendarPlanItem = {
      activityTitle,
      activityType: row.activity_type,
      area,
      conflictKey,
      conflictWarning: null,
      employeeHrId: header.employee_hr_id,
      employeeJobTitle: header.employee_job_title,
      employeeName: header.employee_name,
      employeeDisplayName,
      endDate: row.activity_date,
      id: `plan-${row.id}`,
      lineName,
      medicalRepHrId,
      medicalRepName,
      medicalRepDisplayName,
      notes: cleanText(row.notes) || null,
      planId: header.id,
      planKind: header.plan_kind,
      region,
      source: "plan",
      startDate: row.activity_date,
      status: header.status,
      time: planSlotLabel(row.start_time, row.end_time),
      // title is the rendered UI label (agenda list text + hover tooltip in
      // planning-calendar.tsx) — must be nickname-aware like employeeDisplayName,
      // not the raw legal name (see [[feedback-show-names-not-codes]]).
      title: planningCalendarTitle(employeeDisplayName, region, area, activityTitle),
    };
    return [item];
  });

  return {
    areaRegions,
    directoryByHrId,
    hasMoreHeaders,
    hasMoreItems,
    items,
    loadedHeaderCount: headers.length,
    loadedItemCount: rows.length,
    placeEvidence,
  };
}

/**
 * A district manager's Phoenix CRM week, half-day by half-day (owner, 2026-10-16: it REPLACES his legacy
 * plan once his team is live). Read beside the legacy items so the calendar keeps showing him the week he
 * switches: a half-day "with a rep" books that rep exactly as a legacy Double Visit does, so the
 * same-line conflict check and `getSameLinePlanBookings` see it. Only weeks gone for review or approved.
 *
 * A database that has not had the plan's tables yet (a staging project mid-migration) contributes
 * nothing rather than failing the month; any other failure throws like the legacy read does.
 */
type ManagerHalfDays = Awaited<ReturnType<typeof loadManagerPlanHalfDays>>;

async function readManagerPlanHalfDays(start: string, end: string): Promise<ManagerHalfDays> {
  try {
    return await loadManagerPlanHalfDays({ from: start, to: end });
  } catch (error) {
    const text = error instanceof Error ? error.message : JSON.stringify(error);
    if (/phoenix_crm_manager_plan|PGRST205|42P01/i.test(text)) return [];
    throw error;
  }
}

function managerPlanCalendarItems(
  halfDays: ManagerHalfDays,
  directoryByHrId: Map<string, EmployeeDirectoryRow>,
  placeEvidence: Map<string, string>,
  areaRegions: Map<string, string>,
): PlanningCalendarPlanItem[] {
  return halfDays.flatMap((halfDay) => {
    const employee = directoryByHrId.get(normalizeHrId(halfDay.managerHrId));
    // Same rule as the legacy rows: someone no longer in the directory drops off the shared calendar.
    if (!employee) return [];
    const lineName = employee.lineName ?? null;
    const rep = halfDay.repHrId ? directoryByHrId.get(normalizeHrId(halfDay.repHrId)) : undefined;
    const medicalRepHrId = halfDay.kind === "with_rep" ? halfDay.repHrId : null;
    const medicalRepName = medicalRepHrId ? (rep?.fullName ?? null) : null;
    const medicalRepDisplayName = medicalRepHrId ? (rep?.displayName || medicalRepName) : null;
    const senior = halfDay.seniorHrId ? directoryByHrId.get(normalizeHrId(halfDay.seniorHrId)) : undefined;
    const seniorDisplayName = senior ? (senior.displayName || senior.fullName) : null;
    const activityTitle = managerHalfDayText(halfDay, medicalRepDisplayName, seniorDisplayName);
    const storedArea = halfDay.kind === "single_visit" || halfDay.kind === "with_dm" || halfDay.kind === "with_senior" || halfDay.kind === "with_area" ? halfDay.areaName : null;
    const area = resolvePlanItemArea(storedArea, rep?.areaName, employee.areaName, placeEvidence.get(placeEvidenceKey(halfDay.managerHrId, halfDay.date)));
    const region = resolvePlanItemRegion(null, rep?.regionName, employee.regionName, regionOfArea(areaRegions, area));
    const employeeDisplayName = employee.displayName || employee.fullName;
    const item: PlanningCalendarPlanItem = {
      activityTitle,
      activityType: halfDay.legacyType,
      area,
      conflictKey: planningConflictKey(halfDay.date, lineName, medicalRepHrId),
      conflictWarning: null,
      employeeHrId: halfDay.managerHrId,
      employeeJobTitle: employee.jobTitle ?? "District Manager",
      employeeName: employee.fullName,
      employeeDisplayName,
      endDate: halfDay.date,
      id: `crm-plan-${halfDay.slotId}`,
      lineName,
      medicalRepHrId,
      medicalRepName,
      medicalRepDisplayName,
      notes: halfDay.note,
      planId: halfDay.planId,
      planKind: "weekly",
      region,
      source: "plan",
      startDate: halfDay.date,
      status: managerPlanLegacyStatus(halfDay.status),
      time: halfDay.half,
      withHrId: halfDay.seniorHrId,
      title: planningCalendarTitle(employeeDisplayName, region, area, activityTitle),
    };
    return [item];
  });
}

export async function getSharedPlanningCalendarWorkspace(
  access: AccessContext,
  year: number,
  month: number,
): Promise<PlanningCalendarWorkspace> {
  await assertPermission(access, "weekly_plans", "read");
  const { start, end } = monthBounds(year, month);
  const viewerHrId = normalizeHrId(access.hrId);

  try {
    const [{
      directoryByHrId,
      hasMoreHeaders,
      hasMoreItems,
      items: rawPlanItems,
      loadedHeaderCount,
      loadedItemCount,
    }, holidays, districtManagerHrIds] = await Promise.all([
      loadSubmittedPlanItems(start, end),
      loadHolidayItems(year, month, start, end),
      // The acting District Managers (app role, rep title) — see isAllowedCalendarOwner. A failed
      // read leaves the title-only answer, never a broken calendar.
      activeRoleSignIns(["District Manager"])
        .then((signIns) => new Set(signIns.map((signIn) => normalizeHrId(signIn.hrId)).filter(Boolean)))
        .catch(() => new Set<string>()),
    ]);
    const viewer = directoryByHrId.get(viewerHrId) ?? null;
    const directReportHrIds = new Set(
      [...directoryByHrId.values()]
        .filter((row) => hrIdsMatch(row.managerHrId, access.hrId))
        .map((row) => normalizeHrId(row.hrId)),
    );
    const viewerContext: CalendarViewerContext = {
      hrId: viewerHrId,
      role: access.role,
      lineName: viewer?.lineName ?? null,
      directReportHrIds,
      districtManagerHrIds,
    };
    const visiblePlanItems = rawPlanItems.filter((item) => isPlanItemVisibleToViewer(item, viewerContext));
    // Office days are not drawn, but the person still counts as having submitted a plan.
    // An identical AM and PM for one person on one day is one Full day entry.
    const planItems = mergeFullDayPlanItems(withoutOfficeDays(visiblePlanItems));
    const conflicts = buildPlanningCalendarConflicts(planItems);
    const warnedPlanItems = attachPlanningConflictWarnings(planItems, conflicts);
    const submittedOwners = new Set(visiblePlanItems.map((item) => normalizeHrId(item.employeeHrId)).filter(Boolean));
    return {
      conflicts,
      hasMoreHeaders,
      hasMoreItems,
      headerLimit: CALENDAR_HEADER_LIMIT,
      items: [...holidays, ...warnedPlanItems].sort((left, right) => `${left.startDate}-${left.title}`.localeCompare(`${right.startDate}-${right.title}`)),
      itemLimit: CALENDAR_ITEM_LIMIT,
      loadedHeaderCount,
      loadedItemCount,
      month,
      schemaReady: true,
      summary: {
        conflictCount: conflicts.length,
        holidayCount: holidays.length,
        planCount: planItems.length,
        submittedOwnerCount: submittedOwners.size,
      },
      viewerLineName: viewer?.lineName ?? null,
      weeks: buildMonthGrid(year, month),
      year,
    };
  } catch (error) {
    if (!isPlanningSchemaMissing(error)) throw error;
    const holidays = await loadHolidayItems(year, month, start, end);
    return {
      conflicts: [],
      hasMoreHeaders: false,
      hasMoreItems: false,
      headerLimit: CALENDAR_HEADER_LIMIT,
      items: holidays,
      itemLimit: CALENDAR_ITEM_LIMIT,
      loadedHeaderCount: 0,
      loadedItemCount: 0,
      month,
      schemaReady: false,
      summary: {
        conflictCount: 0,
        holidayCount: holidays.length,
        planCount: 0,
        submittedOwnerCount: 0,
      },
      viewerLineName: null,
      weeks: buildMonthGrid(year, month),
      year,
    };
  }
}

/**
 * The bookings the Plans form may hear about, cut down to what its "already planned with this Medical
 * Rep" warning reads: the rep, the date, and - only where the viewer may already see that manager's plan
 * on the planning calendar (isPlanItemVisibleToViewer) - who booked. Everyone else's activity title,
 * area, region, line and HR id stay on the server. The viewer's own plans are not a booking by "another".
 */
export function selectSameLinePlanBookings(
  items: PlanningCalendarPlanItem[],
  viewer: CalendarViewerContext,
): SameLinePlanBooking[] {
  if (!viewer.lineName) return [];
  const viewerHrId = normalizeHrId(viewer.hrId);
  return items.flatMap((item) => {
    const medicalRepIdentity = item.medicalRepHrId ?? item.medicalRepName;
    if (!medicalRepIdentity || !sameLine(item.lineName, viewer.lineName)) return [];
    if (normalizeHrId(item.employeeHrId) === viewerHrId) return [];
    return [{
      date: item.startDate,
      medicalRepHrId: medicalRepIdentity,
      medicalRepName: item.medicalRepName ?? medicalRepIdentity,
      plannedByDisplayName: isPlanItemVisibleToViewer(item, viewer) ? item.employeeDisplayName : null,
    }];
  });
}

export async function getSameLinePlanBookings(
  access: AccessContext,
  start: string,
  end: string,
): Promise<SameLinePlanBooking[]> {
  await assertPermission(access, "weekly_plans", "read");
  const rangeProblem = sameLineBookingRangeProblem(start, end);
  if (rangeProblem) throw new Error(rangeProblem);
  const [{ directoryByHrId, items }, districtManagerHrIds] = await Promise.all([
    loadSubmittedPlanItems(start, end),
    activeRoleSignIns(["District Manager"])
      .then((signIns) => new Set(signIns.map((signIn) => normalizeHrId(signIn.hrId)).filter(Boolean)))
      .catch(() => new Set<string>()),
  ]);
  const viewerHrId = normalizeHrId(access.hrId);
  const viewer = directoryByHrId.get(viewerHrId);
  if (!viewer?.lineName) return [];
  const directReportHrIds = new Set(
    [...directoryByHrId.values()]
      .filter((row) => hrIdsMatch(row.managerHrId, access.hrId))
      .map((row) => normalizeHrId(row.hrId)),
  );
  return selectSameLinePlanBookings(items, {
    hrId: viewerHrId,
    role: access.role,
    lineName: viewer.lineName,
    directReportHrIds,
    districtManagerHrIds,
  });
}
