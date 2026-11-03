/**
 * Phoenix CRM — the manager's weekly plan, as the screens OUTSIDE the module read it.
 *
 * Every reader here is keyed by the MANAGER'S HR id, never by a district seat, so a regional, national or
 * product manager's week (owner, 2026-10-17) reaches the same screens as a district manager's with no
 * second door. A product manager files his legacy plan as well (the no-weekly-plan deduction reads it),
 * so his calendars show both, side by side — each is a plan he sent.
 *
 * Owner, 2026-10-16: the district manager's Phoenix CRM week REPLACES his legacy Weekly/Monthly plan. Six
 * screens showed that legacy plan — the Planning Calendar, his landing page's plan card, the Action Center,
 * the private calendar, "Decided for me" and the company calendar — and each one would go quiet the week
 * he switched if it kept reading `employee_plan_headers` alone. This file is the one door they read the
 * new plan through, so the table shapes stay inside the module.
 *
 * 🔴 NO NOTICE SENDER IS IMPORTED HERE, AND NONE MAY BE. These readers are imported by the weekly-planning,
 * action-center and calendar services, which the notification layer reaches in turn; a sender pulled in
 * here closes an import cycle. The one reader that needs the full report (`managerPlanAdherence`) loads it
 * lazily for exactly that reason.
 *
 * 🔴 THE REP NEVER READS ANY OF IT. Every function here is keyed by the MANAGER (or, for the Visit report,
 * by the rep seats a Super Admin or SFE reader already holds) — nothing here answers a rep's own screen.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { addBucketToSplit, emptyVisitCountSplit, type VisitCountBucket, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { cairoBusinessDay, fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import type { ManagerDayPlan } from "@/lib/phoenix-crm/manager-day-plan";
import {
  isManagerPlanSent,
  managerAdminActivityLabel,
  singleVisitHalfOfHour,
  type ManagerHalf,
  type ManagerPlannerKind,
  type ManagerPlanStatus,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { cairoHourOf } from "@/lib/phoenix-crm/server/manager-single-visit-cap";
import { loadManagerSlotCustomers, loadManagerSlotRows, MANAGER_PLAN_COLUMNS, managerPlanRowOf, type ManagerPlanRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadManagerOwnVisitDetails as readOwnVisitDetails } from "@/lib/phoenix-crm/server/manager-visit-details";
import type { ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { personKey } from "@/lib/phoenix-crm/scope";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Where one of his weeks opens — the Approvals Hub's plan page answers a Phoenix CRM plan id too. */
export function managerPlanHref(planId: string, surface: "portal" | "admin" = "portal"): string {
  return `${surface === "admin" ? "/admin" : "/employee-portals"}/approvals/plan/${encodeURIComponent(planId)}`;
}

/** "Week of 24 Oct" is built by the caller; the plan's own name for a list line. */
export function managerPlanTitle(weekStart: string): string {
  return `Phoenix CRM weekly plan · ${weekStart}`;
}

/**
 * The legacy plan's activity type a half-day reads as, so a screen built on that list keeps its colours
 * and its rules: with a rep and a single visit are both Field, and the seven day activities map to the five
 * the legacy list had (the rest read as an Event). 🔴 With a rep is NEVER a "Double Visit" (owner,
 * 2026-10-16: "the double visit is only counted when the rep submit and log a visit and choose double
 * visit and his manager") — the half-day's own title names the rep, and the booking of that rep is read
 * from `repHrId`, never from this word.
 */
export type LegacyPlanActivityType = "Field" | "Office" | "Travel" | "Meeting" | "Training" | "Admin" | "Event";

export function managerHalfLegacyType(kind: ManagerSlotKind, activityType: string | null): LegacyPlanActivityType {
  if (kind === "with_rep" || kind === "single_visit" || kind === "with_dm" || kind === "with_senior" || kind === "with_area") return "Field";
  // A regional, national or product manager's Office half-day reads as the legacy plan's own "Office"
  // (owner, 2026-10-17), the word the attendance policy "office days only" keys on.
  if (activityType === "office") return "Office";
  if (activityType === "travel") return "Travel";
  if (activityType === "meeting") return "Meeting";
  if (activityType === "training") return "Training";
  if (activityType === "admin_work") return "Admin";
  return "Event";
}

/** The plan status in the legacy plan's words, for a screen that colours by them. */
export function managerPlanLegacyStatus(status: ManagerPlanStatus): "draft" | "submitted" | "manager_approved" | "final_approved" | "manager_returned" {
  if (status === "submitted") return "submitted";
  if (status === "first_approved") return "manager_approved";
  if (status === "approved") return "final_approved";
  if (status === "returned") return "manager_returned";
  return "draft";
}

/** One half-day of a manager's week, as every outside screen reads it. */
export type ManagerPlanHalfDay = {
  slotId: string;
  planId: string;
  managerHrId: string;
  /** Null only for a product manager, who holds no seat. */
  managerSeatId: string | null;
  plannerKind: ManagerPlannerKind;
  weekStart: string;
  status: ManagerPlanStatus;
  date: string;
  half: ManagerHalf;
  kind: ManagerSlotKind;
  repSeatId: string | null;
  repHrId: string | null;
  activityType: string | null;
  /** "Training", "Admin work" — null unless the half-day is Admin. */
  activityLabel: string | null;
  areaName: string | null;
  /**
   * A district manager's With my manager or product manager: the person he picked (owner, 2026-10-24: their
   * calendar shows it and they are told). Null for every other kind.
   */
  seniorHrId: string | null;
  note: string | null;
  /** Null when the caller asked for no customer counts (`customerCounts: false`) — never a zero it did not read. */
  customerCount: number | null;
  legacyType: LegacyPlanActivityType;
  decidedByHrId: string | null;
  firstApproverHrId: string | null;
  isTest: boolean;
};

/** These managers' plans whose week touches [from, to], of these planner kinds if named. Real world unless asked otherwise. */
export async function loadManagerPlansInRange(input: {
  from: string;
  to: string;
  managerHrIds?: ReadonlyArray<string> | null;
  statuses?: ReadonlyArray<ManagerPlanStatus>;
  isTest?: boolean;
  plannerKinds?: ReadonlyArray<ManagerPlannerKind>;
}): Promise<ManagerPlanRow[]> {
  const isTest = input.isTest ?? false;
  const read = (part: string[] | null) =>
    fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .gte("week_start", addDaysIso(input.from, -6))
          .lte("week_start", input.to)
          .eq("is_test", isTest);
        if (part) query = query.in("manager_hr_id", part);
        if (input.statuses && input.statuses.length > 0) query = query.in("status", [...input.statuses]);
        if (input.plannerKinds && input.plannerKinds.length > 0) query = query.in("planner_kind", [...input.plannerKinds]);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  const rows: Row[] = [];
  if (input.managerHrIds) {
    const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
    for (const part of chunk(keys, 100)) rows.push(...(await read(part)));
  } else {
    rows.push(...(await read(null)));
  }
  return rows.map(managerPlanRowOf).filter((plan): plan is ManagerPlanRow => plan !== null);
}

/**
 * The half-days of these managers' weeks inside [from, to], each carrying its plan's status. Only weeks
 * gone for review or approved unless `sentOnly` is false — a draft is an intention nobody was asked about.
 * `plannerKinds` reads only those planners' weeks, and `customerCounts: false` skips reading the customers
 * of every slot (each `customerCount` is then null) — for a screen that needs the half-days alone.
 */
export async function loadManagerPlanHalfDays(input: {
  from: string;
  to: string;
  managerHrIds?: ReadonlyArray<string> | null;
  statuses?: ReadonlyArray<ManagerPlanStatus>;
  sentOnly?: boolean;
  isTest?: boolean;
  plannerKinds?: ReadonlyArray<ManagerPlannerKind>;
  customerCounts?: boolean;
}): Promise<ManagerPlanHalfDay[]> {
  if (input.managerHrIds && input.managerHrIds.length === 0) return [];
  if (input.plannerKinds && input.plannerKinds.length === 0) return [];
  const plans = (await loadManagerPlansInRange(input)).filter((plan) => input.sentOnly === false || isManagerPlanSent(plan.status));
  if (plans.length === 0) return [];
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const slots = (await loadManagerSlotRows(plans.map((plan) => plan.planId))).filter((slot) => slot.date >= input.from && slot.date <= input.to);
  const customers = input.customerCounts === false ? [] : await loadManagerSlotCustomers(slots.filter((slot) => slot.kind !== "admin").map((slot) => slot.slotId));
  const countBySlot = new Map<string, number>();
  for (const row of customers) countBySlot.set(row.slotId, (countBySlot.get(row.slotId) ?? 0) + 1);
  const out: ManagerPlanHalfDay[] = [];
  for (const slot of slots) {
    const plan = planById.get(slot.planId);
    if (!plan) continue;
    out.push({
      slotId: slot.slotId,
      planId: plan.planId,
      managerHrId: plan.managerHrId,
      managerSeatId: plan.managerSeatId,
      plannerKind: plan.plannerKind,
      weekStart: plan.weekStart,
      status: plan.status,
      date: slot.date,
      half: slot.half,
      kind: slot.kind,
      repSeatId: slot.repSeatId,
      repHrId: slot.repHrId,
      activityType: slot.activityType,
      activityLabel: slot.kind === "admin" ? (managerAdminActivityLabel(slot.activityType) ?? "Admin") : null,
      areaName: slot.areaName,
      seniorHrId: slot.kind === "with_senior" ? (slot.seniorVisit?.seniorHrId ?? null) : null,
      note: slot.note,
      customerCount: input.customerCounts === false ? null : (countBySlot.get(slot.slotId) ?? 0),
      legacyType: managerHalfLegacyType(slot.kind, slot.activityType),
      decidedByHrId: plan.decidedByHrId ?? plan.firstDecidedByHrId,
      firstApproverHrId: plan.firstApproverHrId,
      isTest: plan.isTest,
    });
  }
  return out.sort((left, right) => left.date.localeCompare(right.date) || left.half.localeCompare(right.half));
}

/** A half-day in a line of text: "With Ahmed Ali", "Training", "Single visit · Nasr City". */
export function managerHalfDayText(halfDay: Pick<ManagerPlanHalfDay, "kind" | "activityLabel" | "areaName">, repName: string | null, seniorName: string | null = null): string {
  if (halfDay.kind === "with_rep") return `With ${repName ?? "a rep"}`;
  if (halfDay.kind === "admin") return halfDay.activityLabel ?? "Admin";
  if (halfDay.kind === "with_dm") return `With a district manager · ${halfDay.areaName ?? "the district's areas"}`;
  if (halfDay.kind === "with_senior") return `With ${seniorName ?? "a manager or product manager"} · ${halfDay.areaName ?? "the district's areas"}`;
  if (halfDay.kind === "with_area") return `An area · ${halfDay.areaName ?? "an area of the region"}`;
  return `Single visit · ${halfDay.areaName ?? "an area"}`;
}

/**
 * The Visit report generator's "manager's plan with the rep" rows from the new plan (2026-10-16) — a plan
 * to go with the rep, never a double visit, which only the rep's own logged visit makes — in the shape the
 * old double-visit planner's rows had — `{ id, seat_id, plan_date, half, manager_hr_id }` — so the report
 * reads both, side by side. A half-day "with a rep" on a week gone for review or approved; a day returned to
 * him is not a plan until he sends it again. `seat_id` is the REP's seat.
 */
export async function readManagerWithRepSlotsForReport(
  seatIds: readonly string[],
  window: { from: string; to: string },
  includeTest: boolean,
): Promise<Row[]> {
  const slotRows: Row[] = [];
  // The slot names the rep's seat `rep_seat_id`, so the seat scope is applied here, chunked.
  for (const part of chunk(dedupeIds([...seatIds]), 100)) {
    slotRows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_manager_plan_slots")
            .select("id, plan_id, rep_seat_id, plan_date, half")
            .eq("kind", "with_rep")
            .in("rep_seat_id", part)
            .gte("plan_date", window.from)
            .lte("plan_date", window.to),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  if (slotRows.length === 0) return [];
  const plans: ManagerPlanRow[] = [];
  for (const part of chunk(dedupeIds(slotRows.map((row) => textOrNull(row.plan_id))), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).in("id", part);
        if (!includeTest) query = query.eq("is_test", false);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const plan = managerPlanRowOf(row);
      if (plan) plans.push(plan);
    }
  }
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const out: Row[] = [];
  for (const row of slotRows) {
    const plan = planById.get(String(row.plan_id));
    const date = textOrNull(row.plan_date)?.slice(0, 10) ?? null;
    if (!plan || !date || !isManagerPlanSent(plan.status)) continue;
    out.push({ id: `manager-plan:${String(row.id)}`, seat_id: row.rep_seat_id, plan_date: date, half: row.half, manager_hr_id: plan.managerHrId });
  }
  return out;
}

/** One sent week of his, scored the way the legacy plan card scores a week. */
export type ManagerPlanAdherenceWeek = {
  planId: string;
  weekStart: string;
  weekEnd: string;
  status: ManagerPlanStatus;
  /** Customers whose day has closed: done or not done. */
  checkable: number;
  kept: number;
  scorePct: number | null;
};

/**
 * His last few sent weeks against what happened, newest first — for his landing page's plan card. A
 * customer counts once his day has closed (02:00 Cairo the next morning); a week with no closed customer
 * yet is listed but not measured. Empty for anyone who never sent one.
 */
export async function managerPlanAdherence(
  managerHrId: string | null | undefined,
  day: { cairoToday: string; visitDay: string },
  limit = 4,
): Promise<ManagerPlanAdherenceWeek[]> {
  const key = personKey(managerHrId);
  if (!key) return [];
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plans")
        .select(MANAGER_PLAN_COLUMNS)
        .eq("manager_hr_id", key)
        .eq("is_test", false)
        .in("status", ["submitted", "first_approved", "approved"])
        .lte("week_start", day.cairoToday),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const plans = rows
    .map(managerPlanRowOf)
    .filter((plan): plan is ManagerPlanRow => plan !== null)
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart))
    .slice(0, limit);
  if (plans.length === 0) return [];
  // Loaded here, not at the top: the report reaches the visit and customer services, which send notices.
  const { computeManagerReports } = await import("@/lib/phoenix-crm/server/manager-plan-report");
  const reports = await Promise.all(plans.map((plan) => computeManagerReports(day, [key], plan.weekStart, false, new Map())));
  return plans.map((plan, index) => {
    const summary = reports[index].get(key)?.summary ?? { planned: 0, done: 0, notDone: 0, unplanned: 0 };
    const checkable = summary.done + summary.notDone;
    return {
      planId: plan.planId,
      weekStart: plan.weekStart,
      weekEnd: addDaysIso(plan.weekStart, 5),
      status: plan.status,
      checkable,
      kept: summary.done,
      scorePct: checkable > 0 ? Math.round((summary.done / checkable) * 100) : null,
    };
  });
}

/**
 * Decisions on these managers' weeks since a moment — for "Decided for me": who decided which stage, and
 * when. One line per decided stage; the Administrator acting in place of the holder is a decision too.
 */
export type ManagerPlanDecision = {
  planId: string;
  managerHrId: string;
  weekStart: string;
  stage: "first" | "final";
  /** Whose step it was: his first approver's (RSM/NSM) or the second approver's. */
  approverStage: "first" | "second";
  decision: "approved" | "returned";
  decidedAt: string;
  decidedByHrId: string;
  decidedRole: string | null;
  note: string | null;
};

export async function loadManagerPlanDecisions(managerHrIds: ReadonlyArray<string>, sinceIso: string): Promise<ManagerPlanDecision[]> {
  const keys = dedupeIds(managerHrIds.map((hrId) => personKey(hrId)));
  if (keys.length === 0) return [];
  const out: ManagerPlanDecision[] = [];
  for (const part of chunk(keys, 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .in("manager_hr_id", part)
          .eq("is_test", false)
          .or(`first_decided_at.gte.${sinceIso},decided_at.gte.${sinceIso}`),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const raw of rows) {
      const plan = managerPlanRowOf(raw);
      if (!plan) continue;
      if (plan.firstDecidedAt && plan.firstDecidedByHrId && plan.firstDecidedAt >= sinceIso) {
        out.push({
          planId: plan.planId,
          managerHrId: plan.managerHrId,
          weekStart: plan.weekStart,
          stage: "first",
          approverStage: "first",
          decision: "approved",
          decidedAt: plan.firstDecidedAt,
          decidedByHrId: plan.firstDecidedByHrId,
          decidedRole: plan.firstDecidedRole,
          note: plan.firstDecisionNote,
        });
      }
      // A week with one stage stamps both columns with the same approval — one decision, one line.
      const sameAsFirst = plan.status !== "returned" && plan.decidedAt === plan.firstDecidedAt && plan.decidedByHrId === plan.firstDecidedByHrId;
      if (plan.decidedAt && plan.decidedByHrId && plan.decidedAt >= sinceIso && !sameAsFirst) {
        out.push({
          planId: plan.planId,
          managerHrId: plan.managerHrId,
          weekStart: plan.weekStart,
          stage: "final",
          approverStage: !plan.secondApproverHrId ? "first" : plan.status === "returned" ? (plan.returnedStage ?? "second") : "second",
          decision: plan.status === "returned" ? "returned" : "approved",
          decidedAt: plan.decidedAt,
          decidedByHrId: plan.decidedByHrId,
          decidedRole: plan.decidedByRole,
          note: plan.decisionNote,
        });
      }
    }
  }
  return out.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}

// ── His own single visits, as "did he work that day" ───────────────────────────────────────────

/** One manager, one day, and how many of his own single visits he logged on it. */
export type ManagerOwnVisitDay = {
  hrId: string;
  date: string;
  visits: number;
  /**
   * How many of those fell in each half: a planned visit keeps its half, an unplanned one the Cairo half it
   * was logged in (`singleVisitHalfOfHour`, the rule the weekly cap counts by). `loadManagerOwnVisitDays`
   * always fills them, so `am + pm === visits`; OPTIONAL only so a caller that builds a day by hand for
   * the "did he work" question (which reads `visits` alone) need not invent a split.
   */
  am?: number;
  pm?: number;
  /**
   * 🔴 THE SAME VISITS AS AM · PM · PHARMACIES — BY THE CUSTOMER'S LIST, NEVER BY THE HALF (owner, 2026-10-23:
   * "if a manager himself added a visit to a pharmacy, it should be count … separate … same for district
   * managers, and same in everywhere"). `am`/`pm` above are HALVES of the day — the weekly cap and the plan
   * count by them — and a pharmacy he called on in the morning sat inside them as an AM visit. This is the
   * golden rule's split: a rep customer's own list decides (a pharmacy is Pharmacies, whatever the half);
   * a customer of Manager's own list carries no list, so its half decides. `am + pm + pharmacies === visits`.
   */
  split?: VisitCountSplit;
};

/**
 * 🔴 A MANAGER'S OWN SINGLE VISIT IS A RECORD OF HIS DAY (owner, 2026-10-19, multiple choice: "count it
 * on both").
 *
 * His own visits live in a table of their own precisely so that no KPI, coverage, call-rate, frequency
 * or target reader can pick one up — and that is unchanged. **This reader answers a different question**:
 * not how he performed, but whether anything at all is recorded for him that day. Since 2026-10-16 his
 * own visit no longer lands in `phoenix_crm_visits`, so a district manager who spent a whole day on his
 * own single visits reached the Field Absence Calendar and the no-activity engine as a man with NO
 * record — measured on production the day this was written: Mina Farouk Nawar Rizkallah and Mohamed Alaa
 * Eleiwa Abozaid, 19 Oct 2026, nothing in the visits door, no punch, no vacation, no trip.
 *
 * It ADDS days and never removes one, and it is read through this adapter like every other outside
 * read of his week, so the table's shape stays inside the module.
 */
export async function loadManagerOwnVisitDays(input: {
  start: string;
  end: string;
  managerHrIds?: ReadonlyArray<string> | null;
  isTest?: boolean;
}): Promise<ManagerOwnVisitDay[]> {
  if (input.end < input.start) return [];
  const isTest = input.isTest ?? false;
  const read = (part: string[] | null) =>
    fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin()
          .from("phoenix_crm_manager_visits")
          .select("id, manager_hr_id, visit_date, half, created_at, customer_id")
          .gte("visit_date", input.start)
          .lte("visit_date", input.end)
          .eq("is_test", isTest);
        if (part) query = query.in("manager_hr_id", part);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  const rows: Row[] = [];
  if (input.managerHrIds) {
    const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
    if (keys.length === 0) return [];
    for (const part of chunk(keys, 100)) rows.push(...(await read(part)));
  } else {
    rows.push(...(await read(null)));
  }

  const listTypes = await readCustomerListTypes(rows.map((row) => textOrNull(row.customer_id)));

  const counts = new Map<string, ManagerOwnVisitDay>();
  for (const row of rows) {
    const hrId = personKey(textOrNull(row.manager_hr_id));
    const date = (textOrNull(row.visit_date) ?? "").slice(0, 10);
    if (!hrId || date.length !== 10) continue;
    const key = `${hrId}|${date}`;
    // An unplanned visit has no half of its own: the Cairo hour it was logged in decides, as it does for the cap.
    const created = textOrNull(row.created_at);
    const half: ManagerHalf = row.half === "AM" || row.half === "PM" ? row.half : singleVisitHalfOfHour(created ? cairoHourOf(created) : 0);
    const current = counts.get(key) ?? { am: 0, date, hrId, pm: 0, split: emptyVisitCountSplit(), visits: 0 };
    current.visits += 1;
    if (half === "AM") current.am = (current.am ?? 0) + 1;
    else current.pm = (current.pm ?? 0) + 1;
    const customerId = textOrNull(row.customer_id);
    const listType = customerId ? listTypes.get(customerId) : undefined;
    addBucketToSplit(current.split ?? (current.split = emptyVisitCountSplit()), ownVisitBucket(listType ?? null, half), 1, true);
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => left.date.localeCompare(right.date) || left.hrId.localeCompare(right.hrId));
}

/**
 * The area of the customers a manager visited, one entry per visit (owner, 2026-10-24: "check his CRM
 * visits, where was he"). The Planning Calendar reads it to fill a plan day that names no area. Real
 * visits only, and a visit with no area says nothing.
 */
export async function loadManagerVisitAreas(input: { start: string; end: string }): Promise<Array<{ areaName: string; date: string; hrId: string }>> {
  if (input.end < input.start) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_visits")
    .select("manager_hr_id,visit_date,area_name")
    .gte("visit_date", input.start)
    .lte("visit_date", input.end)
    .eq("is_test", false)
    .not("area_name", "is", null)
    .limit(5000);
  if (error) throw error;
  return (data ?? []).flatMap((row) => {
    const hrId = textOrNull(row.manager_hr_id);
    const date = (textOrNull(row.visit_date) ?? "").slice(0, 10);
    const areaName = textOrNull(row.area_name);
    return hrId && date.length === 10 && areaName ? [{ areaName, date, hrId }] : [];
  });
}

/**
 * The bucket one of his own visits counts in: the rep customer's list when he visited one (a pharmacy is
 * Pharmacies whatever the hour), else — a customer of Manager's own list, which has no list — the half.
 * Pure, exported for its test.
 */
export function ownVisitBucket(customerListType: string | null, half: ManagerHalf): VisitCountBucket {
  if (customerListType === "AM" || customerListType === "PM" || customerListType === "Pharmacy") {
    return visitCountBucketForListType(customerListType);
  }
  return half;
}

/** The list each rep customer sits on, for the customers his own visits name. A failed read throws. */
async function readCustomerListTypes(customerIds: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const ids = dedupeIds(customerIds.filter((id): id is string => Boolean(id)));
  const out = new Map<string, string>();
  for (const part of chunk(ids, 100)) {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, list_type").in("id", part);
    if (error) throw new Error(`Phoenix CRM manager visits: reading the customers' lists failed — ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const listType = textOrNull(row.list_type);
      if (listType) out.set(String(row.id), listType);
    }
  }
  return out;
}

/**
 * 🔴 HIS OWN VISITS AS ROWS UNDER HIS OWN NAME (owner, 2026-10-20, multiple choice: "Show, keep out of reps — his
 * own visits appear under his name in the Visit Report and the Field Activity day, never in a rep's totals. Still
 * no GPS or photo required").
 *
 * The second carve-out from "his own single visits count in his own report only", and like the first it is read
 * through this door alone. Each row is one single visit he logged alone — a vacant area's doctor included — with
 * the customer, the place and the half filled in (`loadManagerOwnVisitDetails`). They are DISPLAY rows: the Visit
 * report prints them under the manager's name (its dashboard figures leave them out), the Field Activity day lists
 * them on his day and adds them to none of its counts, and neither ever puts one on a rep's row or in a rep's
 * total. A row never carries a distance, a GPS verdict or a photo verdict — his own visit needs none of them.
 *
 * Who may read them is the CALLER's question, answered before it asks: the Visit report only for a manager its
 * own picker offered the viewer, the Field Activity report only for the person its own access already admitted.
 */
export async function loadManagerOwnVisitRows(input: {
  managerHrIds: ReadonlyArray<string>;
  start: string;
  end: string;
  isTest?: boolean;
}): Promise<ManagerDayVisit[]> {
  if (input.managerHrIds.length === 0 || input.end < input.start) return [];
  return readOwnVisitDetails({ end: input.end, isTest: input.isTest ?? false, managerHrIds: input.managerHrIds, start: input.start });
}

/**
 * Every manager's own visit on an empty territory since a day, as the seat it fell on and its date, and nothing
 * else: no manager, no customer, no verdict. For the Empty Seats board, which asks only whether anybody is going
 * there, so unlike the rest of this file it is keyed by TERRITORY. It is no KPI: the board prints it as "logged".
 *
 * The seat is read off the customer, whichever list he came from: a rep's list (`customer_id`) or his own
 * (`manager_customer_id`). A dropped customer still counts, since the visit happened. A visit neither list can
 * place comes back with a null seat. A failed read throws; the caller says so on the page.
 */
export async function loadManagerVacantTerritoryVisits(input: { from: string }): Promise<Array<{ seatId: string | null; visitDate: string | null }>> {
  const supabase = getSupabaseAdmin();
  const visits = await fetchAllRowsKeyset<{
    customer_id: string | null;
    id: string;
    manager_customer_id: string | null;
    visit_date: string | null;
  }>(
    () =>
      supabase
        .from("phoenix_crm_manager_visits")
        .select("id, customer_id, manager_customer_id, visit_date")
        .eq("in_vacant_territory", true)
        .eq("is_test", false)
        .gte("visit_date", input.from),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
  const seatsOf = async (table: string, column: string, ids: ReadonlyArray<string | null>) => {
    const seats = new Map<string, string>();
    for (const part of chunk(dedupeIds(ids))) {
      const { data, error } = await supabase.from(table).select(`id, ${column}`).in("id", part);
      if (error) throw error;
      for (const row of (data ?? []) as unknown as Row[]) {
        const seatId = textOrNull(row[column]);
        const id = textOrNull(row.id);
        if (id && seatId) seats.set(id, seatId);
      }
    }
    return seats;
  };
  const [repCustomers, ownCustomers] = await Promise.all([
    seatsOf("phoenix_crm_customers", "seat_id", visits.map((row) => row.customer_id)),
    seatsOf("phoenix_crm_manager_customers", "area_seat_id", visits.map((row) => row.manager_customer_id)),
  ]);
  return visits.map((row) => ({
    seatId:
      (row.customer_id ? repCustomers.get(row.customer_id) : undefined) ??
      (row.manager_customer_id ? ownCustomers.get(row.manager_customer_id) : undefined) ??
      null,
    visitDate: row.visit_date,
  }));
}

// His visits in full — who, where, which half, when, single or double (owner, 2026-10-20). The count above says
// that he worked; this says what he did, and is read through this same door.
export {
  loadManagerOwnVisitDetails,
  loadManagerRideAlongDetails,
  loadManagerVisitDetails,
  // Every rep's visits in full, the same record (owner, 2026-10-21: "everyone, exactly as Mina Farouk").
  loadRepVisitDetails,
  type ManagerVisitDetailInput,
  type RepVisitDetailInput,
} from "@/lib/phoenix-crm/server/manager-visit-details";

/**
 * The plan behind each of these managers' days, keyed `<manager>|<day>` — the weekly report's own read, so a
 * screen that shows a day beside the plan cannot disagree with the report (owner, 2026-10-20: "plan vs actual vs
 * detail per visit in actual"). EVERY day of every week the window touches has an entry for every manager asked
 * about: a day he planned nothing on is a sent week with no half-day, not a missing plan, and a week with no sent
 * plan reads `sent: false`. A failed read throws; the caller decides how loud to be.
 */
export async function loadManagerDayPlans(input: { end: string; managerHrIds: ReadonlyArray<string>; start: string }): Promise<Map<string, ManagerDayPlan>> {
  const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
  const out = new Map<string, ManagerDayPlan>();
  if (keys.length === 0 || input.end < input.start) return out;
  const weeks: string[] = [];
  for (let week = fieldWeekStart(input.start); week <= input.end; week = addDaysIso(week, 7)) weeks.push(week);
  const day = { cairoToday: currentCairoDateOnlyIso(), visitDay: cairoBusinessDay(new Date()) };
  // Loaded here, not at the top: the report reaches the visit and customer services, which send notices.
  const { computeManagerReports } = await import("@/lib/phoenix-crm/server/manager-plan-report");
  const reports = await Promise.all(weeks.map((week) => computeManagerReports(day, keys, week, false, new Map())));
  weeks.forEach((week, index) => {
    for (const [hrId, report] of reports[index]) {
      const sent = isManagerPlanSent(report.status);
      for (let offset = 0; offset < 7; offset += 1) {
        const date = addDaysIso(week, offset);
        out.set(`${hrId}|${date}`, { halves: report.days.find((entry) => entry.date === date)?.halves ?? [], sent, statusLine: report.statusLine });
      }
    }
  });
  return out;
}

/** What a screen prints beside the day. Never a figure anybody is measured on — a record that he worked. */
export function describeManagerOwnVisitDay(day: ManagerOwnVisitDay): string {
  return `Phoenix CRM: ${day.visits} own single visit${day.visits === 1 ? "" : "s"}`;
}
