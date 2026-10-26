// Private calendar: the APPROVED weekly plan as a coverage source.
//
// Why this exists: the calendar read attendance, leave, excuses, national holidays and CRM visits —
// every one of them a record of something that was captured by a device or a form. A field manager's
// approved Travel, Admin or Meeting day produces none of those by design: nobody punches a
// fingerprint in Sohag, and there is no customer visit to log. So the day read "No Activity
// Recorded" although the employee's own manager had approved exactly that day, in writing, in
// Phoenix, days earlier — which is what the 4 October 2026 review request was about.
//
// 🔴 THE PLAN SHOWS ON EVERY DAY IT COVERS, BUT IT ONLY EXCUSES THE DAY FOR AN ACTIVITY PHOENIX
// RECORDS NOWHERE ELSE. A planned Field or Double Visit day with no visit logged, a planned Office
// day with no punch, a planned Vacation with no approved leave request — each of those is a REAL gap,
// and the plan is the thing that proves it was expected, never the thing that excuses it. Measured on
// production for 1 Aug – 7 Oct 2026: letting every planned type excuse the day would have erased 364
// genuine gaps (318 planned double visits with no visit logged, 25 planned Office days with no punch,
// 21 planned Field days with nothing recorded), which feed the Deductions module's No Records
// Activity connector. The seven types below cover 38 days in the same window and are the whole
// intended effect.
//
// A plan is only read once its manager has signed it off — `manager_approved` or `hr_acknowledged`.
// A draft, a submitted plan awaiting a decision, a returned, rejected or cancelled one is an
// intention nobody approved and covers nothing.
//
// Read-only. Never mutates plan, attendance or deduction data.

import { hrIdLookupKeys } from "@/lib/hr-id";
import { loadManagerPlanHalfDays, managerHalfDayText, type ManagerPlanHalfDay } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readAllPrivateCalendarRows, type PrivateCalendarItem } from "@/lib/private-calendar/logic";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { weekOfLabel } from "@/lib/weekly-planning/plan-labels";
import { dropPendingRevisionsOfPlansOfRecord } from "@/lib/weekly-planning/plan-revisions";

/**
 * The plan statuses that mean a manager has signed the week off.
 *
 * `final_approved` rides along because the plan workflow's own helpers list it
 * (src/lib/attendance/plan-office-days.ts) even though production holds no weekly header in that
 * state — keeping it costs nothing and a future CEO-approved weekly plan is then already covered.
 */
export const APPROVED_PLAN_STATUSES = ["manager_approved", "final_approved", "hr_acknowledged"] as const;

/**
 * The planned activity types Phoenix records in no other system, so an approved plan item is the only
 * thing the day will ever carry.
 *
 * 🔴 **A WEEKLY PLAN NEVER EXCUSES A DAY — ANY ACTIVITY TITLE.** Owner, 2026-10-12: *"NEVER COUNT
 * WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?"*, and then *"Do not ever touch a
 * weekly plan. All what you do that you see the weekly plan and the daily reports and compare the
 * plan versus the actual, any title."* So this list is a DISPLAY and COMPARISON fact — it says the
 * day will have nothing else to show next to the plan — and it is read by nothing that clears an
 * exception or suppresses a deduction. From 2026-10-07 to 2026-10-12 these seven types did excuse a
 * No Activity day and did clear a half day; that is what his ruling reversed.
 *
 * Deliberately NOT here either, and each for a named reason — the records that DO excuse a day:
 *   · `Field`, `Double Visit` — the CRM is the record. Nothing logged on a planned visit day is the
 *     exact gap the exceptions board exists to surface.
 *   · `Office` — the fingerprint is the record; the plan's own office lookup says so in as many words
 *     ("the employee was expected in the building ... so a punch should exist",
 *     src/lib/attendance/plan-office-days.ts). A person with no device mapping is an enrolment
 *     problem or an attendance exception, never a planning one.
 *   · `Vacation`, `Excuse`, `National Vacation` — the leave request, the excuse request and the
 *     holiday calendar are the records. A plan is not an approval for time off, and treating it as
 *     one would let a day be taken off the books without a leave request ever existing.
 */
export const PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE = [
  "Admin",
  "Event",
  "Meeting",
  "Meeting with Team",
  "Other",
  "Training",
  "Travel",
] as const;

const typesRecordedNowhereElse = new Set<string>(PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE.map((type) => type.toLowerCase()));

/**
 * Whether Phoenix records this kind of planned activity nowhere else — so the reader comparing the
 * plan against the actual should expect no punch and no logged visit beside it.
 *
 * 🔴 It is NOT coverage and never was meant to be read as proof of work (owner, 2026-10-12). The name
 * says what it is for that reason: the previous name, `plannedActivityCoversTheDay`, is exactly how a
 * display fact came to suppress a deduction.
 *
 * Pure, and exported so the rule above is asserted on plain strings rather than inferred from a
 * database read. An unknown or blank activity type answers false.
 */
export function plannedActivityIsRecordedNowhereElse(activityType: string | null | undefined): boolean {
  return typesRecordedNowhereElse.has(String(activityType ?? "").trim().toLowerCase());
}

type PlanItemRow = {
  activity_date: string | null;
  activity_title: string | null;
  activity_type: string | null;
  area: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string | null;
  objective: string | null;
  start_time: string | null;
};

type PlanHeaderRow = {
  employee_hr_id: string | null;
  employee_name: string | null;
  employee_plan_items: PlanItemRow[] | null;
  id: string;
  manager_name: string | null;
  parent_plan_id: string | null;
  period_key: string | null;
  status: string | null;
};

const PLAN_SELECT =
  "id,employee_hr_id,employee_name,manager_name,parent_plan_id,period_key,status," +
  "employee_plan_items(id,activity_date,activity_type,activity_title,objective,area,location_text,notes,start_time,end_time,double_visit_medical_rep_name,sort_order)";

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function nullableText(value: string | null | undefined) {
  const text = cleanText(value);
  return text.length > 0 ? text : null;
}

/** "09:00" from a Postgres `time` — the seconds are noise on a calendar chip. */
function shortTime(value: string | null | undefined) {
  const text = cleanText(value);
  return text.length >= 5 ? text.slice(0, 5) : null;
}

function timeRange(start: string | null | undefined, end: string | null | undefined) {
  const from = shortTime(start);
  const to = shortTime(end);
  if (from && to) return `${from} – ${to}`;
  return from ?? to ?? "Planned day";
}

function schemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

export function mapPlanRowToPrivateCalendarItem(
  header: Pick<PlanHeaderRow, "employee_hr_id" | "employee_name" | "manager_name" | "period_key" | "status">,
  item: PlanItemRow,
): PrivateCalendarItem {
  const date = cleanText(item.activity_date).slice(0, 10);
  const activityType = cleanText(item.activity_type) || "Planned activity";
  const title = cleanText(item.activity_title) || activityType;
  const recordedNowhereElse = plannedActivityIsRecordedNowhereElse(item.activity_type);
  const place = nullableText(item.area) ?? nullableText(item.location_text);
  const detailLines = [`Activity: ${activityType}`];
  if (place) detailLines.push(`Where: ${place}`);
  if (nullableText(item.objective)) detailLines.push(`Objective: ${cleanText(item.objective)}`);
  if (nullableText(item.double_visit_medical_rep_name)) {
    detailLines.push(`With: ${cleanText(item.double_visit_medical_rep_name)}`);
  }
  // "Week of 18 Oct", never the week code or a bare ISO date (NSM audit, 2026-10-26).
  if (nullableText(header.period_key)) detailLines.push(weekOfLabel(header.period_key) || `Week: ${cleanText(header.period_key)}`);
  // The approving manager goes in the detail lines, not only in `managerName`: the workspace
  // overwrites that field with the employee's CURRENT manager from the directory
  // (decorateItemsWithEmployeeMetadata), so who actually signed this week off would otherwise be lost
  // on the one item where it is the whole point.
  if (nullableText(header.manager_name)) detailLines.push(`Approved by: ${cleanText(header.manager_name)}`);
  return {
    // The plan is an intention, never a visit, so it carries no visit colour of its own.
    activityKind: "plan",
    // Neither branch excuses the day any more (owner, 2026-10-12): a plan is what was intended, and
    // the day is still judged on what was recorded. The two lines differ only in what the reader
    // should expect to find beside the plan.
    approvalImpact: recordedNowhereElse
      ? "Approved by the manager, and the only thing this kind of day produces — so compare it against what was actually recorded; it does not stand in for attendance."
      : "Approved by the manager. The day still needs its own record: a punch, a logged visit or an approved request.",
    chipLines: [activityType === title ? activityType : `${activityType} · ${title}`, ...(place ? [place] : [])],
    description: nullableText(item.notes),
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: header.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: nullableText(header.employee_name),
    endDate: date,
    exceptionFlags: [],
    id: `plan-${item.id}`,
    managerName: nullableText(header.manager_name),
    plannedActivityIsRecordedNowhereElse: recordedNowhereElse,
    // An APPROVED plan is news, never something to review — the same reasoning as an approved excuse.
    severity: "info",
    source: "plan",
    sourceLabel: "Approved weekly plan",
    sourceRecordId: item.id,
    sourceSystem: "Weekly planning",
    sourceTable: "employee_plan_items",
    startDate: date,
    status: cleanText(header.status) === "hr_acknowledged" ? "HR acknowledged" : "Manager approved",
    time: timeRange(item.start_time, item.end_time),
    title,
  };
}

/**
 * One half-day of a district manager's approved Phoenix CRM week, as a calendar item (owner, 2026-10-16:
 * that week REPLACES his legacy plan once his team is live). Display only, like every plan item here: a
 * half-day "with a rep" and a single visit both read as Field — never a Double Visit, which only the rep's
 * own logged visit makes — and an Admin half-day keeps its activity's name.
 */
export function mapManagerHalfDayToPrivateCalendarItem(
  halfDay: ManagerPlanHalfDay,
  names: { rep: string | null; approver: string | null; senior?: string | null },
): PrivateCalendarItem {
  const activityType = halfDay.legacyType;
  const title = managerHalfDayText(halfDay, names.rep, names.senior ?? null);
  const recordedNowhereElse = plannedActivityIsRecordedNowhereElse(activityType);
  const detailLines = [`Activity: ${activityType}`, `Half day: ${halfDay.half}`];
  if ((halfDay.kind === "single_visit" || halfDay.kind === "with_senior" || halfDay.kind === "with_area") && halfDay.areaName) detailLines.push(`Where: ${halfDay.areaName}`);
  if (halfDay.kind !== "admin" && halfDay.customerCount !== null) detailLines.push(`Customers planned: ${halfDay.customerCount}`);
  detailLines.push(weekOfLabel(halfDay.weekStart) || `Week: ${halfDay.weekStart}`);
  if (names.approver) detailLines.push(`Approved by: ${names.approver}`);
  return {
    activityKind: "plan",
    approvalImpact: recordedNowhereElse
      ? "Approved by the manager, and the only thing this kind of day produces — so compare it against what was actually recorded; it does not stand in for attendance."
      : "Approved by the manager. The day still needs its own record: a punch, a logged visit or an approved request.",
    chipLines: [activityType === title ? activityType : `${activityType} · ${title}`],
    description: halfDay.note,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: halfDay.managerHrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: halfDay.date,
    exceptionFlags: [],
    id: `crm-plan-${halfDay.slotId}`,
    managerName: names.approver,
    plannedActivityIsRecordedNowhereElse: recordedNowhereElse,
    severity: "info",
    source: "plan",
    sourceLabel: "Approved weekly plan",
    sourceRecordId: halfDay.slotId,
    sourceSystem: "Phoenix CRM",
    sourceTable: "phoenix_crm_manager_plan_slots",
    startDate: halfDay.date,
    status: halfDay.status === "approved" ? "Approved" : "Manager approved",
    time: halfDay.half,
    title,
  };
}

/** His signed-off Phoenix CRM half-days for these people, as calendar items. */
async function loadManagerPlanPrivateCalendarItems(employeeHrIds: string[], start: string, end: string): Promise<PrivateCalendarItem[]> {
  const halfDays = await loadManagerPlanHalfDays({ from: start, to: end, managerHrIds: employeeHrIds, statuses: ["first_approved", "approved"] });
  if (halfDays.length === 0) return [];
  const names = await loadPeopleNames(halfDays.flatMap((halfDay) => [halfDay.repHrId, halfDay.decidedByHrId, halfDay.seniorHrId]));
  return halfDays.map((halfDay) =>
    mapManagerHalfDayToPrivateCalendarItem(halfDay, {
      rep: halfDay.repHrId ? nameOf(names, halfDay.repHrId, "a rep") : null,
      approver: halfDay.decidedByHrId ? nameOf(names, halfDay.decidedByHrId, "") || null : null,
      senior: halfDay.seniorHrId ? nameOf(names, halfDay.seniorHrId, "") || null : null,
    }),
  );
}

/**
 * Every approved WEEKLY plan item for these employees inside [start, end], as calendar items.
 *
 * Weekly only, which is the owner's own wording ("the approved weekly plan"): the weekly plan is the
 * operative one — 198 approved weekly headers in production against a single monthly one — and the
 * monthly plan is a skeleton the weekly one then fills in. `plan_kind` is in the query, so widening
 * to monthly later is one word.
 *
 * The items ride along on the header read rather than a second query by plan id: the headers are
 * already filtered to the right people, statuses and period, so one round trip returns the whole
 * month. Paged through readAllPrivateCalendarRows — never a fixed limit, which would silently drop
 * the back of a team view.
 *
 * `ready: false` only when the plan tables are not there at all (a fresh database, a staging project
 * mid-migration); the calendar then says the source could not be read rather than showing a confident
 * empty month.
 */
export async function loadPlanPrivateCalendarItems(
  employeeHrIds: string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  const lookupKeys = Array.from(
    new Set(employeeHrIds.flatMap((value) => hrIdLookupKeys(String(value ?? "").trim())).filter(Boolean)),
  );
  if (lookupKeys.length === 0) return { items: [], ready: true };
  try {
    const headers = await readAllPrivateCalendarRows<PlanHeaderRow>((from, to) => getSupabaseAdmin()
      .from("employee_plan_headers")
      .select(PLAN_SELECT)
      .eq("plan_kind", "weekly")
      .in("status", APPROVED_PLAN_STATUSES)
      .in("employee_hr_id", lookupKeys)
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .order("period_start_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to));
    const items: PrivateCalendarItem[] = [];
    // A revision awaiting its decisions (manager_approved is in the list above) is left out while
    // the approved plan it revises is the plan of record, or the week would be read twice.
    for (const header of dropPendingRevisionsOfPlansOfRecord(headers)) {
      for (const item of header.employee_plan_items ?? []) {
        const date = cleanText(item.activity_date).slice(0, 10);
        // A week straddles a month boundary, so the header's period overlapping the range does not
        // make every item of it in range.
        if (!date || date < start || date > end) continue;
        items.push(mapPlanRowToPrivateCalendarItem(header, item));
      }
    }
    try {
      items.push(...(await loadManagerPlanPrivateCalendarItems(employeeHrIds, start, end)));
    } catch (error) {
      // A database without the plan's tables yet adds nothing; anything else fails the source like the legacy read.
      if (!/phoenix_crm_manager_plan|PGRST205|42P01/i.test(error instanceof Error ? error.message : JSON.stringify(error))) throw error;
    }
    return { items, ready: true };
  } catch (error) {
    if (schemaMissing(error)) return { items: [], ready: false };
    throw error;
  }
}

