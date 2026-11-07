/**
 * Phoenix CRM — the monthly plan: the umbrella above the weekly plans, its meters, and the month's
 * submit / reopen / approve / return.
 *
 * Owner, 2026-09-25: a rep makes ONE monthly plan — a real calendar of dated placements — and his
 * weekly plans are that plan's field-weeks. The system helps him build it in step with frequency,
 * coverage and the call rate; he approves the month once, and a later edit to a single week needs that
 * week approved again.
 *
 * The placements themselves stay in the weekly plan tables (phoenix_crm_plans / _plan_items), saved
 * through the shipped weekly `savePlan` — nothing about how a day is built changes. This file adds the
 * month header (phoenix_crm_monthly_plans) that owns the field-weeks whose Saturday falls in the
 * calendar month (calendar.ts `fieldWeeksOfMonth`), reads the whole month in one pass to show the
 * per-doctor deviation and the AM / PM meters, and cascades the month's status down to its weeks
 * through `phoenix_crm_monthly_plan_transition`. AM and PM are ALWAYS reported apart, NEVER averaged
 * (the call-rate golden rule).
 *
 * Per-week re-approval after the month is approved is free: the month leaves each week its own status
 * and version, so editing one approved week flips just that week back to submitted through the existing
 * weekly `transitionPlan`, and the month stays approved.
 *
 * Owner, 2026-09-29: this is now THE plan screen — "monthly or weekly, and the weeks roll up into the
 * month". The month sits on top as Week 1..N; each week carries its own plan, its own due date (the
 * Thursday before it) and its own send / approve buttons, so a rep who plans a week at a time and one
 * who sends the whole month use the same board.
 *
 * 🔴 Owner, 2026-10-01 — WEEKLY ONLY, after the first Delta (1) session: the board opened on September
 * (the first plannable month), four reps pressed "Send the month" and were stamped late, and one
 * planned a week that had passed. Now:
 *   - the board opens on the month of the rep's ONE week (calendar.ts `repPlanWeek`), every other week
 *     greyed for him (`repState`), and the server refuses a save or a send of any other week;
 *   - a rep no longer sends or takes back a MONTH — `transitionMonthlyPlanAsRep` refuses both, so a
 *     screen one release behind gets a sentence. The month stays the frame the weeks sit in, with its
 *     meters; a reviewer's month decision is untouched;
 *   - a sent week changes only through "Ask to edit this week" (plan-edits.ts).
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate, formatPhoenixMonth } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import {
  boardLeadingWeek,
  boardLeadingWeekIsRunning,
  editablePlanDays,
  fieldWeeksOfMonth,
  isIsoDay,
  isMonthKey,
  isRamadanDay,
  monthEndOf,
  monthlyPlanDueOn,
  monthStartOf,
  plannableMonths,
  planDeadlinePassed,
  repPlanWeek,
  weeklyPlanDueOn,
  weekNumberInMonth,
} from "@/lib/phoenix-crm/calendar";
import { cleanText, parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { checkDaySpread } from "@/lib/phoenix-crm/geo";
import {
  monthlyCallRate,
  summarizeMonthlyList,
  tallyDoctorMonth,
  type DoctorMonthTally,
  type MonthlyCallRate,
  type MonthlyListMeter,
} from "@/lib/phoenix-crm/monthly-plan-rules";
import type { PlanDayStarts } from "@/lib/phoenix-crm/plan-day-starts";
import { planEditAsksLeft } from "@/lib/phoenix-crm/plan-edit-rules";
import { sentChangesOf, type PlanSentChanges, type SentEvent } from "@/lib/phoenix-crm/plan-review-rules";
import {
  isPlanEditable,
  isUuid,
  onlyReturnedDayEditable,
  PLAN_DECISION_NOTE_MAX,
  planDueLabel,
  planStatusLine,
  standingReturnedDay,
  type RepWeekState,
} from "@/lib/phoenix-crm/plan-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { seatOccupants } from "@/lib/phoenix-crm/scope";
import {
  assertCanReturnPlan,
  assertReviewer,
  canOverrideDecision,
  canReturnTerritoryPlan,
  canEnterMissedRecords,
  canReviewTerritory,
  canWriteAsRep,
  readTestFlag,
  testReadSeats,
  territoryForRead,
  territoryForRepWrite,
  worldFor,
  type PhoenixCrmViewer,
  type TestWorldRead,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { ensureReferenceCustomersRecently, loadMonthVisitCounts, loadPlannerReferences, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanActivities, type PlannedActivityRow } from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlanDayStarts } from "@/lib/phoenix-crm/server/plan-day-starts";
import { loadSeatDaysOff, loadSeatPendingLeave } from "@/lib/phoenix-crm/server/leave-days";
import { loadPeopleOutstationTrips } from "@/lib/phoenix-crm/server/outstation-trips";
import type { PlanOutstationTrip } from "@/lib/phoenix-crm/outstation-trip-banner";
import { editAcknowledgedAt, loadPlanEditState, repStateOf, type PlanEditRequestView, type PlanEditState } from "@/lib/phoenix-crm/server/plan-edits";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { loadPlannerInsights } from "@/lib/phoenix-crm/server/plan-insight";
import { loadPlanSends } from "@/lib/phoenix-crm/server/plan-review";
import {
  buildDays,
  ITEM_COLUMNS,
  isStaleItem,
  listTypeOf,
  loadPlanItemRows,
  mapPlan,
  PLAN_COLUMNS,
  PLAN_READ_CONCURRENCY,
  planPeople,
  REVIEW_ITEM_COLUMNS,
  statusOf,
  territoryReadiness,
  venueNamesOf,
  type PlanDayView,
  type PlanSaveReads,
  type PlanSummary,
  type SavedPlan,
  type TerritoryReadiness,
} from "@/lib/phoenix-crm/server/plans";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { doctorNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { effectiveListType, type PlannerCustomer, type PlannerInsight, type PlannerPlace } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

const MONTHLY_PLAN_COLUMNS =
  "id, seat_id, line_code, month_start, status, version, submitted_at, submitted_by_hr_id, decided_at, decided_by_hr_id, " +
  "decided_by_role, decision_note, created_by_hr_id, updated_at, is_test, due_on, submitted_late";

/**
 * The requested month, clamped to the plannable months. By default the board opens on the month of the
 * rep's own week (owner, 2026-10-01): on 1 October the first plannable month was still September, and
 * the reps had to find October themselves.
 */
function resolveMonth(value: unknown, plannable: string[], fallback?: string): string {
  if (isMonthKey(value) && plannable.includes(`${value}-01`)) return `${value}-01`;
  if (isIsoDay(value) && plannable.includes(monthStartOf(value))) return monthStartOf(value);
  return fallback && plannable.includes(fallback) ? fallback : plannable[0];
}

// ── The month header ──────────────────────────────────────────────────────────────────────────────

export type MonthlyPlanSummary = {
  monthlyPlanId: string;
  monthStart: string;
  status: PhoenixCrmPlanStatus;
  statusLabel: string;
  version: number;
  submittedAt: string | null;
  submittedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  /** True when the SFE Manager, not the reviewing manager, decided. */
  decidedBySfe: boolean;
  decisionNote: string | null;
  updatedAt: string;
  /**
   * When the month was due: the last Thursday of the month before (owner, 2026-09-26). Null only for a
   * header opened before the rule existed and never reopened since.
   */
  dueOn: string | null;
  /**
   * It was sent after that Thursday. Read from the SERVER's clock at submit and stamped on the row, so
   * a screen drawn weeks later still tells the truth. Nothing was blocked — his ruling was that a late
   * plan is ACCEPTED and STAMPED, because a rep who cannot plan cannot work.
   */
  submittedLate: boolean;
};

function mapMonthlyPlan(row: Row, names: PeopleNames, people?: { repName: string | null; reviewerName: string | null }): MonthlyPlanSummary {
  const status = statusOf(row.status);
  const submittedBy = textOrNull(row.submitted_by_hr_id);
  const decidedBy = textOrNull(row.decided_by_hr_id);
  return {
    monthlyPlanId: String(row.id),
    monthStart: String(row.month_start),
    status,
    // The month wears the same named status as its weeks (owner, 2026-10-08) — one composer for both,
    // because the four states and their words are the same and a second copy would drift.
    statusLabel: planStatusLine({
      status,
      repName: people?.repName ?? null,
      reviewerName: people?.reviewerName ?? null,
      deciderName: decidedBy ? nameOf(names, decidedBy) : null,
    }),
    version: Number(row.version),
    submittedAt: textOrNull(row.submitted_at),
    submittedByName: submittedBy ? nameOf(names, submittedBy) : null,
    decidedAt: textOrNull(row.decided_at),
    decidedByName: decidedBy ? nameOf(names, decidedBy) : null,
    decidedBySfe: row.decided_by_role === "sfe_manager",
    decisionNote: textOrNull(row.decision_note),
    updatedAt: String(row.updated_at),
    dueOn: textOrNull(row.due_on),
    submittedLate: row.submitted_late === true,
  };
}

// ── The planner ─────────────────────────────────────────────────────────────────────────────────

/** One doctor across the whole month: his grade norm, how many days he is placed on, the deviation. */
export type MonthlyDoctorRow = DoctorMonthTally & {
  name: string;
  speciality: string | null;
  /** Carried over from iReports360 and not validated yet: no grade norm, left out of the meters. */
  pending: boolean;
};

/** What the board calls the week a month opens with and does not own (owner, 2026-10-01). */
export const LEADING_WEEK_LABEL = "First days";
/** ...and the week the rep is in, whenever that is the week the board opens with — even when it also holds the month's first days (2026-10-31). */
export const RUNNING_WEEK_LABEL = "This week";

/** A field-week of the month, with its own status and its days (the derived weekly plan). */
export type MonthlyWeekView = {
  weekStart: string;
  /** "Week 1", "Week 2"… of this month. 0 on the leading week, which belongs to another month. */
  weekNumber: number;
  /** What the board calls it: "Week 1", or "First days" for the leading week. */
  label: string;
  /**
   * 🔴 THE WEEK THIS MONTH OPENS WITH AND DOES NOT OWN (owner, 2026-10-01). It is the PREVIOUS month's
   * last week, shown here because it holds this month's first field days — in FULL, all six of them,
   * because it is one week with one plan row, one editable window and one send. It is not in
   * `fieldWeeksOfMonth`, so it enters no meter, no call rate and no monthly cascade here: sending the
   * month does NOT send it, which is the whole trap, so `leadingNote` says that in words.
   */
  leading: boolean;
  /** On the leading week only: that it is sent on its own, with the month it belongs to. */
  leadingNote: string | null;
  status: PhoenixCrmPlanStatus | null;
  statusLabel: string;
  days: PlanDayView[];
  /** The week's own plan, once it has one — its version is what a save or a send checks. */
  plan: PlanSummary | null;
  /** The Thursday before the week: when it is due if it is sent on its own. */
  dueOn: string;
  dueOnLabel: string;
  /** The due date has passed and the week is still not sent. A late week is accepted, and stamped. */
  overdue: boolean;
  /** The week still has a day the rep may change. */
  open: boolean;
  /**
   * What the rep may do with it (owner, 2026-10-01 — weekly only): plan it, ask to edit it once sent,
   * wait on that request, or nothing — greyed. "closed" for anyone who is not its rep.
   */
  repState: RepWeekState;
  /** The rep ticks, saves and sends it. */
  canEdit: boolean;
  canSubmit: boolean;
  /**
   * The rep may press "Ask to edit this week": it is sent, still has days ahead, nothing is asked yet, and
   * an ask is left — two a week at most (owner, 2026-10-20).
   */
  canAskToEdit: boolean;
  /** The asks this week has left, 0 to 2: every request ever raised on it counts, whatever became of it. */
  editAsksLeft: number;
  /**
   * The request a week shows: the one on its way, else the last one while its answer still stands — a
   * refusal on a week still sent, an acknowledgement on a week still open again. Null otherwise.
   */
  editRequest: PlanEditRequestView | null;
  canApprove: boolean;
  canReturn: boolean;
  /**
   * The ONE day a reviewer returned, while it stands (owner, 2026-10-02: "Only that day" reopens). Every
   * other day of the week reads `editable: false` — greyed on the rep's board and refused by `savePlan`.
   * Null for a week returned whole, every week that is not returned, and one opened whole since by an
   * acknowledged edit.
   */
  returnedDay: string | null;
  /**
   * For the people who decide a SENT week (owner, 2026-10-02): what changed against the version sent
   * before it — the days, the customers added and removed, the activities. Null for anyone else, and on
   * any week that is not waiting for review.
   */
  sentChanges: PlanSentChanges | null;
};

export type MonthlyPlannerView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  monthStart: string;
  monthLabel: string;
  /**
   * The last Thursday of the month before — when this month's plan is due (owner, 2026-09-26). Shown
   * before the header exists too, so the deadline is on the screen from the moment he opens the month
   * rather than appearing only once he has started. NOTHING refuses a plan after it: his ruling was
   * that a late month is accepted and stamped, because a rep who cannot plan cannot work.
   */
  dueOn: string;
  dueOnLabel: string;
  /** The due date has passed and the month is still not sent. */
  overdue: boolean;
  months: Array<{ monthStart: string; label: string; status: PhoenixCrmPlanStatus | null; statusLabel: string }>;
  readiness: TerritoryReadiness;
  /** Customers carried over from iReports360 and not validated yet. Information, never a refusal. */
  pendingCount: number;
  rules: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap" | "farApartKm" | "gradeTargets" | "callRateAmTarget" | "callRatePmTarget">;
  plan: MonthlyPlanSummary | null;
  weeks: MonthlyWeekView[];
  /** Every on-list customer, AM and PM, with his month deviation. Pending ones show but score nothing. */
  tallies: MonthlyDoctorRow[];
  amMeter: MonthlyListMeter;
  pmMeter: MonthlyListMeter;
  callRate: MonthlyCallRate;
  /** The validated list with places and timings, for the day's suggestions and filters on the phone. */
  customers: PlannerCustomer[];
  viewerIsRep: boolean;
  viewerIsReviewer: boolean;
  /** The Super Admin may delete a week's plan, or the whole month's, as if it never happened (owner, 2026-10-23). */
  adminDeletes: boolean;
  /** The one week the rep plans now (calendar.ts `repPlanWeek`) — where his board opens. */
  repWeek: string;
  /** The month's own send and take-back: always false since 2026-10-01 (a rep sends a week at a time). */
  canEdit: boolean;
  canSubmit: boolean;
  canReopen: boolean;
  canApprove: boolean;
  canReturn: boolean;
  /** Why the rep cannot plan this month, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
  /**
   * The territory person's business trips over the board's days (owner, 2026-11-07: "Trip on the CRM
   * side") — "On an outstation trip to X" above the weeks. Optional so a saved-board answer and an
   * older screen keep compiling; empty when there is none or the read failed.
   */
  outstationTrips?: PlanOutstationTrip[];
};

/** The month's four meters — what a save of one of its own weeks moves. */
type MonthMeters = Pick<MonthlyPlannerView, "tallies" | "amMeter" | "pmMeter" | "callRate">;

/** The fields of a planner customer the month's meters read. */
type MeterCustomer = Pick<PlannerCustomer, "customerId" | "name" | "listType" | "grade" | "speciality" | "pending">;

/**
 * One customer of the list as the month counts him, or null for a pharmacy, which is never planned. One
 * composer for the board and for the answer to a save, so the two can never count a customer apart.
 */
function meterCustomerOf(row: Row, places: Parameters<typeof effectiveListType>[1]): MeterCustomer | null {
  const listType = listTypeOf(row.list_type);
  if (listType === null) return null;
  return {
    customerId: String(row.id),
    name: String(row.name),
    // A seated customer is planned and counted in the session of his seating (owner, 2026-10-10).
    listType: effectiveListType(listType, places),
    grade: parseGrade(row.grade),
    speciality: textOrNull(row.speciality),
    pending: row.status === "pending",
  };
}

/** The planner's customer order: AM first, then by name. The tallies keep it among equals. */
function byListThenName(left: MeterCustomer, right: MeterCustomer): number {
  return left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name);
}

/**
 * The month's meters off the placements of its OWN weeks (never the leading week's — `itemRows` is
 * handed in without them). AM and PM are always reported apart, never averaged (the call-rate golden
 * rule). `customers` come in the planner's order (`byListThenName`).
 */
function monthMeters(input: {
  monthStart: string;
  settings: PhoenixCrmViewer["config"]["settings"];
  customers: ReadonlyArray<MeterCustomer>;
  itemRows: ReadonlyArray<Row>;
}): MonthMeters {
  const { monthStart, settings, itemRows } = input;
  // Placements across the whole month, per customer and per list.
  const placementsByCustomer = new Map<string, number>();
  let amPlacements = 0;
  let pmPlacements = 0;
  for (const item of itemRows) {
    const customerId = String(item.customer_id);
    placementsByCustomer.set(customerId, (placementsByCustomer.get(customerId) ?? 0) + 1);
    const itemListType = listTypeOf(item.list_type);
    if (itemListType === null) continue;
    if (itemListType === "AM") amPlacements += 1;
    else pmPlacements += 1;
  }

  const tallies: MonthlyDoctorRow[] = input.customers.map((customer) => {
    const placed = placementsByCustomer.get(customer.customerId) ?? 0;
    const tally = tallyDoctorMonth({ customerId: customer.customerId, listType: customer.listType, grade: customer.grade, placed }, settings);
    return { ...tally, name: customer.name, speciality: customer.speciality, pending: customer.pending };
  });
  tallies.sort(
    (left, right) =>
      left.listType.localeCompare(right.listType) ||
      Number(left.done) - Number(right.done) ||
      Number(left.pending) - Number(right.pending) ||
      left.name.localeCompare(right.name),
  );

  // A customer not validated yet has no grade norm, so he is left out of the meters (his placements
  // still count for the call rate, which measures the days worked, not the panel).
  const scored = tallies.filter((row) => !row.pending);
  const amMeter = summarizeMonthlyList(scored, "AM");
  const pmMeter = summarizeMonthlyList(scored, "PM");
  const callRate = monthlyCallRate({ monthStart, amPlacements, pmPlacements }, settings);
  return { tallies, amMeter, pmMeter, callRate };
}

/**
 * Everything one week of the month board is drawn from. One builder serves the board
 * (`loadMonthlyPlanner`) and the answer to a save (`loadMonthlyWeekAfterSave`), so a week a save answers
 * with reads exactly as the same week read with its month.
 */
type MonthlyWeekInputs = {
  viewer: PhoenixCrmViewer;
  isTest: boolean;
  monthStart: string;
  today: string;
  /** ONE instant for the whole answer, so every week on it agrees about the deadline. */
  now: Date;
  /** The leading week is the week the rep is in — the month's first days included — so it is "This week" (calendar.ts `boardLeadingWeekIsRunning`). */
  leadingIsRunning: boolean;
  settings: PhoenixCrmViewer["config"]["settings"];
  isRamadan: (isoDay: string) => boolean;
  names: PeopleNames;
  territory: TerritorySummary;
  editState: ReadonlyMap<string, PlanEditState>;
  activities: ReadonlyMap<string, PlannedActivityRow[]>;
  starts: ReadonlyMap<string, PlanDayStarts>;
  holidays: ReadonlyMap<string, string>;
  leave: ReadonlyMap<string, string>;
  pendingLeave: ReadonlyMap<string, string>;
  sends: ReadonlyMap<string, SentEvent[]>;
  decidesWeeks: boolean;
  repForWeeks: boolean;
  reviewerForWeeks: boolean;
  returnerForWeeks: boolean;
};

// One builder for both, so the leading week is judged by exactly the same rules as the month's own —
// its own plan row, its own editable window, its own Send. Only its name and its note differ.
function buildMonthlyWeekView(inputs: MonthlyWeekInputs, weekStart: string, planRow: Row | null, weekItems: Row[], leading: boolean): MonthlyWeekView {
  const { viewer, isTest, monthStart, today, now, leadingIsRunning, settings, isRamadan, names, territory, editState } = inputs;
  const { activities, starts, holidays, leave, pendingLeave, sends, decidesWeeks, repForWeeks, reviewerForWeeks, returnerForWeeks } = inputs;
  const weekStatus = planRow ? statusOf(planRow.status) : null;
  const weekPlan = planRow ? mapPlan(planRow, names, territory) : null;
  // One week at a time (owner, 2026-10-01): the same answer the server gives a save or a send.
  const edit: PlanEditState | null = planRow ? (editState.get(String(planRow.id)) ?? null) : null;
  // A week returned for ONE day (owner, 2026-10-02: "Only that day"): that day alone is the rep's to
  // change — the same days `savePlan` accepts — and every other day reads as fixed, which greys it.
  const returnedDay = standingReturnedDay({
    status: weekStatus,
    returnedDay: weekPlan?.returnedDay ?? null,
    decidedAt: weekPlan?.decidedAt ?? null,
    editAcknowledgedAt: editAcknowledgedAt(edit),
  });
  const builtDays = buildDays({ weekStart, cairoToday: today, itemRows: weekItems, farApartKm: settings.farApartKm, isRamadan, activities, starts, holidays, leave, pendingLeave });
  const days = onlyReturnedDayEditable(builtDays, returnedDay);
  const dueOn = weekPlan?.dueOn ?? weeklyPlanDueOn(weekStart);
  const open = editablePlanDays(weekStart, today).length > 0;
  const staleOpen = days.some((day) => day.editable && day.items.some((item) => item.stale));
  const repState: RepWeekState = repForWeeks ? repStateOf({ weekStart, cairoToday: today, status: weekStatus, edit }) : "closed";
  const canEdit = repState === "plan";
  const editAsksLeft = planEditAsksLeft(edit?.asked ?? 0);
  const latest = edit?.latest ?? null;
  const editRequest =
    edit?.waiting ??
    (latest && ((latest.status === "refused" && (weekStatus === "submitted" || weekStatus === "approved")) || (latest.status === "reopened" && weekStatus === "draft"))
      ? latest
      : null);
  const previousMonth = formatPhoenixMonth(addDaysIso(monthStart, -1));
  return {
    weekStart,
    weekNumber: leading ? 0 : weekNumberInMonth(weekStart),
    label: leading ? (leadingIsRunning ? RUNNING_WEEK_LABEL : LEADING_WEEK_LABEL) : `Week ${weekNumberInMonth(weekStart)}`,
    leading,
    // Where this week is filed, said where he is standing: it belongs to the month before.
    leadingNote: leading
      ? leadingIsRunning
        ? `This is the week you are in, from ${formatPhoenixLongDate(weekStart)}. It belongs to ${previousMonth}.`
        : `These are the first days of ${formatPhoenixMonth(monthStart)}, on the week of ${formatPhoenixLongDate(weekStart)} — which belongs to ${previousMonth}.`
      : null,
    status: weekStatus,
    statusLabel: planStatusLine({
      status: weekStatus,
      repName: territory.repName,
      reviewerName: territory.reviewerName,
      deciderName: weekPlan?.decidedByName ?? null,
      passed: !open,
    }),
    days,
    plan: weekPlan,
    dueOn,
    dueOnLabel: planDueLabel(dueOn),
    // A rep is told only about the week he can still send; a manager reads it on every open week.
    // Judged on the DEADLINE INSTANT, not on the date: between 23:55 and midnight a date test would
    // call the week not-yet-overdue while the server stamps that same send late.
    overdue:
      (repForWeeks ? canEdit : open)
      && planDeadlinePassed(dueOn, now)
      && (weekStatus === null || weekStatus === "draft" || weekStatus === "returned"),
    open,
    repState,
    canEdit,
    canSubmit: canEdit && weekStatus !== null && isPlanEditable(weekStatus) && weekItems.length > 0 && !staleOpen,
    canAskToEdit: repState === "sent" && weekPlan !== null && editAsksLeft > 0,
    editAsksLeft,
    editRequest,
    canApprove: (reviewerForWeeks || canOverrideDecision(viewer, isTest)) && weekStatus === "submitted",
    canReturn: open && returnerForWeeks && (weekStatus === "submitted" || weekStatus === "approved"),
    returnedDay,
    sentChanges: decidesWeeks && weekStatus === "submitted" && planRow ? sentChangesOf(sends.get(String(planRow.id)) ?? []) : null,
  };
}

export async function loadMonthlyPlanner(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; month: unknown },
): Promise<MonthlyPlannerView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.cairoToday;
  // ONE instant for the whole render, so the month and every week on it agree about the deadline. Read
  // twice, a request that crosses 23:55 would show one week overdue and the next not.
  const now = new Date();
  const months = plannableMonths(today);
  const monthStart = resolveMonth(raw.month, months, monthStartOf(repPlanWeek(today)));
  const weeks = fieldWeeksOfMonth(monthStart);
  // The week this month OPENS with and does not own — read beside the month's own weeks and kept out
  // of every meter below (owner, 2026-10-01; calendar.ts `leadingFieldWeekOfMonth`) — or, on the month
  // of the rep's own week, the week he is in, so its "Ask to edit" stays reachable (`boardLeadingWeek`).
  const leadingWeek = boardLeadingWeek(monthStart, today);
  const leadingIsRunning = boardLeadingWeekIsRunning(leadingWeek, today);

  // 🔴 TWO CHAINS SIDE BY SIDE, NOT THREE WAVES IN A ROW (2026-10-01, "slow to transfer between page
  // and page", Phoenix CRM first) — the weekly planner's own shape, see loadPlanner in plans.ts. The
  // customer list and the readiness count follow the reference mint, which can change what they read,
  // and the references follow the customer list; the month's plan headers, its weeks and this month's
  // visit counts cannot name a customer minted a moment ago, so they start beside the mint, and the
  // items, activities, starts and names follow the plan rows alone. The three plan reads still fail in
  // the order they always did, and the mint's own failure is still the one that surfaces first.
  const supabase = getSupabaseAdmin();
  // Who decides this territory's weeks — known before the plan rows are read, because a week waiting on
  // their decision brings what its sends kept (what changed since the last send, owner 2026-10-02).
  const decidesWeeks = canReviewTerritory(viewer, seat, isTest) || canReturnTerritoryPlan(viewer, seat, isTest);
  // The mint runs at most once per seat in five minutes (2026-10-23, every page change under 1 second;
  // ensureReferenceCustomersRecently in list.ts): inside that window the customer list starts at once,
  // and the first open still mints before it reads.
  const ensured = ensureReferenceCustomersRecently(seat, isTest);
  const planPartsRead = (async () => {
    // TWO reads, not four (2 Nov 2026, the speed root cause, Stage 2 — each request is ~450 ms at
    // Supabase's edge): the month's own header rides in the plannable months' read, and the leading week
    // in the month's weeks' read. The same rows as before, each asked for once.
    const monthStarts = [...new Set([...months, monthStart])];
    const weekStarts = leadingWeek && !weeks.includes(leadingWeek) ? [...weeks, leadingWeek] : weeks;
    const [monthsResult, weekRowsResult] = await Promise.all([
      supabase.from("phoenix_crm_monthly_plans").select(MONTHLY_PLAN_COLUMNS).eq("seat_id", seat.seatId).eq("is_test", isTest).in("month_start", monthStarts),
      weekStarts.length > 0
        ? supabase.from("phoenix_crm_plans").select(PLAN_COLUMNS).eq("seat_id", seat.seatId).eq("is_test", isTest).in("week_start", weekStarts)
        : Promise.resolve({ data: [] as Row[], error: null }),
    ]);
    throwIfError(monthsResult.error);
    throwIfError(weekRowsResult.error);
    const monthRows = (monthsResult.data ?? []) as unknown as Row[];
    const headerRow = monthRows.find((row) => String(row.month_start) === monthStart) ?? null;
    const weekRows = (weekRowsResult.data ?? []) as Row[];
    const planRows = weekRows.filter((row) => weeks.includes(String(row.week_start)));
    const leadingRow = leadingWeek ? (weekRows.find((row) => String(row.week_start) === leadingWeek) ?? null) : null;
    // 🔴 ONE READ, TWO BAGS. The leading week's items ride along so its days can be drawn, and are
    // then taken OUT of `itemRows` — which is what every meter, tally and call rate below is built
    // from. Letting them through would move October's numbers by another month's week, silently.
    const planIds = planRows.map((row) => String(row.id));
    const leadingId = leadingRow ? String(leadingRow.id) : null;
    const allIds = leadingId ? [...planIds, leadingId] : planIds;
    // The weeks waiting on this viewer's decision bring their sends (owner, 2026-10-02) — and nobody
    // else's board reads them, the rep's own included.
    const reviewIds = decidesWeeks
      ? [...planRows, ...(leadingRow ? [leadingRow] : [])].filter((row) => row.status === "submitted").map((row) => String(row.id))
      : [];
    const [allItemRows, names, activities, starts, editState, sends] = await Promise.all([
      loadPlanItemRows(allIds, ITEM_COLUMNS),
      loadPeopleNames([
        ...territoryPeople(viewer.org, [seat]),
        ...planPeople([...(headerRow ? [headerRow] : []), ...planRows, ...(leadingRow ? [leadingRow] : [])]),
      ]),
      loadPlanActivities(allIds),
      loadPlanDayStarts(allIds),
      // Each week's request to edit it (owner, 2026-10-01), beside the rest — never a wave of its own.
      loadPlanEditState(allIds, isTest),
      loadPlanSends(reviewIds),
    ]);
    const itemRows = leadingId ? allItemRows.filter((row) => String(row.plan_id) !== leadingId) : allItemRows;
    const leadingItems = leadingId ? allItemRows.filter((row) => String(row.plan_id) === leadingId) : [];
    return { monthsResult, headerRow, planRows, itemRows, leadingRow, leadingItems, names, activities, starts, editState, sends };
  })();
  const customersRead = ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }));
  const wave = Promise.all([
    planPartsRead,
    customersRead,
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    ensured.then(() => territoryReadiness(seat.seatId, isTest, false)),
    customersRead.then(({ customers }) => loadPlannerReferences(seat.seatId, isTest, customers)),
    // Two weeks either side of the month reach every week the board can show, the leading one included.
    loadPlanHolidays(addDaysIso(monthStart, -14), addDaysIso(monthEndOf(monthStart), 14)),
    // Last seen, the usual days and a follow-up due (owner, 2026-10-02): its Phoenix visits start now,
    // and only its iReports360 half follows the customer list — never a wave of its own. Only the rep
    // plans from them, so a reviewer's board reads none.
    canWriteAsRep(viewer, seat, isTest) ? loadPlannerInsights(seat.seatId, isTest, today, customersRead) : Promise.resolve(new Map<string, PlannerInsight>()),
    // The rep's own full days of approved leave are days off too (owner, 2026-10-02), over the same days.
    loadSeatDaysOff(seat, { from: addDaysIso(monthStart, -14), to: addDaysIso(monthEndOf(monthStart), 14) }),
    // Leave he has asked for and nobody has decided: named on the plan, never a day off (owner, 2026-10-08).
    loadSeatPendingLeave(seat, { from: addDaysIso(monthStart, -14), to: addDaysIso(monthEndOf(monthStart), 14) }),
    // The building each seated place sits in, by name, so the plan can say WHICH polyclinic or centre a
    // customer is in (owner, 2026-10-10). Wording only: the cap never depends on this read. It needs the
    // places alone, so it follows the customer list inside the wave instead of trailing after it
    // (2026-10-16 speed audit).
    customersRead.then(({ placesByCustomer, venueNames }) => venueNamesOf(placesByCustomer, venueNames)),
    // The territory person's business trips over the same days, for the banner. Never fails the board.
    loadPeopleOutstationTrips(seatOccupants(seat), { from: addDaysIso(monthStart, -14), to: addDaysIso(monthEndOf(monthStart), 14) }),
  ]);
  wave.catch(() => undefined);
  await ensured;
  const [
    { monthsResult, headerRow, planRows, itemRows, leadingRow, leadingItems, names, activities, starts, editState, sends },
    { customers, placesByCustomer },
    visitCounts,
    readiness,
    references,
    holidays,
    insights,
    leave,
    pendingLeave,
    venueNames,
    outstationTrips,
  ] = await wave;

  const settings = viewer.config.settings;
  const isRamadan = (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides);

  const plannerCustomers: PlannerCustomer[] = customers.flatMap((row) => {
    const customerId = String(row.id);
    const places: PlannerPlace[] = (placesByCustomer.get(customerId) ?? []).map((place) => ({
      placeId: place.placeId,
      label: place.label,
      address: place.address,
      lat: place.lat,
      lon: place.lon,
      brick: place.brickName,
      zone: place.zone,
      timings: place.timings,
      sharedPlaceId: place.sharedPlaceId ?? null,
      sharedPlaceName: place.sharedPlaceId ? (venueNames.get(place.sharedPlaceId)?.name ?? null) : null,
      session: place.session ?? null,
    }));
    // A pharmacy is never planned, so it is not offered to the monthly planner either.
    const counted = meterCustomerOf(row, places);
    if (counted === null) return [];
    return {
      customerId,
      name: counted.name,
      listType: counted.listType,
      grade: counted.grade,
      speciality: counted.speciality,
      visitsThisMonth: visitCounts.get(customerId) ?? 0,
      pending: counted.pending,
      needsFullName: doctorNeedsFullName({
        listType: row.list_type,
        origin: row.origin,
        status: row.status,
        name: row.name,
        fullNameHeld: row.full_name_held,
      }),
      reference: references.get(customerId) ?? null,
      insight: insights.get(customerId) ?? null,
      places,
    };
  });
  plannerCustomers.sort(byListThenName);

  const { tallies, amMeter, pmMeter, callRate } = monthMeters({ monthStart, settings, customers: plannerCustomers, itemRows });

  const itemsByPlan = new Map<string, Row[]>();
  for (const row of itemRows) {
    const planId = String(row.plan_id);
    const list = itemsByPlan.get(planId) ?? [];
    list.push(row);
    itemsByPlan.set(planId, list);
  }
  const territory = describeTerritory(viewer.org, seat, names);
  const weekInputs: MonthlyWeekInputs = {
    viewer,
    isTest,
    monthStart,
    today,
    now,
    leadingIsRunning,
    settings,
    isRamadan,
    names,
    territory,
    editState,
    activities,
    starts,
    holidays,
    leave,
    pendingLeave,
    sends,
    decidesWeeks,
    repForWeeks: canWriteAsRep(viewer, seat, isTest) && Boolean(seat.lineCode),
    reviewerForWeeks: canReviewTerritory(viewer, seat, isTest),
    returnerForWeeks: canReturnTerritoryPlan(viewer, seat, isTest),
  };
  const weekViews: MonthlyWeekView[] = weeks.map((weekStart) => {
    const planRow = planRows.find((row) => String(row.week_start) === weekStart) ?? null;
    return buildMonthlyWeekView(weekInputs, weekStart, planRow, planRow ? itemsByPlan.get(String(planRow.id)) ?? [] : [], false);
  });
  // 🔴 FIRST IN THE LIST, AND OUTSIDE `weekViews` — the month's own flags below (`staleOnOpenDays`,
  // and through it the month's Send) are about the month's OWN weeks, and must not be gated on a week
  // that belongs to the month before.
  const leadingView = leadingWeek ? buildMonthlyWeekView(weekInputs, leadingWeek, leadingRow, leadingItems, true) : null;

  const monthStatusByStart = new Map<string, PhoenixCrmPlanStatus>();
  for (const row of (monthsResult.data ?? []) as unknown as Row[]) monthStatusByStart.set(String(row.month_start), statusOf(row.status));

  const plan = headerRow ? mapMonthlyPlan(headerRow, names) : null;
  const status = plan?.status ?? null;
  // The header carries its own due date once it exists; before that the rule computes it, so the two
  // can never show a rep two different Thursdays for the same month.
  const dueOn = plan?.dueOn ?? monthlyPlanDueOn(monthStart);
  const viewerIsRep = canWriteAsRep(viewer, seat, isTest);
  const viewerIsReviewer = canReviewTerritory(viewer, seat, isTest);
  const monthOpen = months.includes(monthStart) && monthEndOf(monthStart) >= today;

  let blockedReason: string | null = null;
  if (viewerIsRep) {
    if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so it cannot be planned.";
    else if (!monthOpen || ![leadingView, ...weekViews].some((week) => week?.repState === "plan" || week?.repState === "sent")) {
      blockedReason = `You plan one week at a time: the week starting ${formatPhoenixLongDate(repPlanWeek(today))}.`;
    }
  }

  return {
    territory,
    isTest,
    cairoToday: today,
    monthStart,
    monthLabel: formatPhoenixMonth(monthStart),
    dueOn,
    dueOnLabel: planDueLabel(dueOn),
    overdue: planDeadlinePassed(dueOn, now) && (status === null || status === "draft" || status === "returned"),
    months: months.map((month) => {
      const monthStatus = monthStatusByStart.get(month) ?? null;
      return {
        monthStart: month,
        label: formatPhoenixMonth(month),
        status: monthStatus,
        statusLabel: planStatusLine({ status: monthStatus, repName: territory.repName, reviewerName: territory.reviewerName }),
      };
    }),
    readiness,
    pendingCount: plannerCustomers.filter((customer) => customer.pending).length,
    rules: {
      pmDailyCap: settings.pmDailyCap,
      amDailyCap: settings.amDailyCap,
      farApartKm: settings.farApartKm,
      gradeTargets: settings.gradeTargets,
      callRateAmTarget: settings.callRateAmTarget,
      callRatePmTarget: settings.callRatePmTarget,
    },
    plan,
    weeks: leadingView ? [leadingView, ...weekViews] : weekViews,
    tallies,
    amMeter,
    pmMeter,
    callRate,
    customers: plannerCustomers,
    viewerIsRep,
    viewerIsReviewer,
    adminDeletes: canEnterMissedRecords(viewer),
    repWeek: repPlanWeek(today),
    // A rep no longer sends or takes back a MONTH (owner, 2026-10-01 — weekly only): these stay false,
    // and transitionMonthlyPlanAsRep refuses both for a screen one release behind.
    canEdit: false,
    canSubmit: false,
    canReopen: false,
    canApprove: (viewerIsReviewer || canOverrideDecision(viewer, isTest)) && status === "submitted",
    canReturn: monthOpen && canReturnTerritoryPlan(viewer, seat, isTest) && (status === "submitted" || status === "approved"),
    blockedReason,
    outstationTrips,
  };
}

// ── The board's answer to a save ──────────────────────────────────────────────────────────────────

/**
 * What a save of the rep's own board answers with besides the save itself (owner, 2026-10-02 — his board
 * saves itself): the week it saved, and — when that week is one of the month's own — the month's meters,
 * each built by the very code `loadMonthlyPlanner` draws them with. The board puts these in place of
 * its own and reads nothing again. Nothing else on the board moves on a save: a save never changes a
 * week's status, the month's header, the list, the readiness count or another week.
 */
export type SavedWeekBoard = {
  /** The month the board showed when it saved — the answer is only ever put on that month. */
  monthStart: string;
  week: MonthlyWeekView;
  /** Null when the saved week is the leading one: it enters no meter, so the board's stand as they are. */
  meters: MonthMeters | null;
};

/**
 * 🔴 THE AUTOSAVE NO LONGER READS THE WHOLE MONTH AGAIN (2026-10-16 speed audit). Every pause in the
 * rep's ticking saved the week and then re-read the whole month — 16 to 22 reads, eight deep, 2.3 s at
 * the median — only to redraw the one week he had saved and the meters it moved. The save already holds
 * most of what that week is drawn from (its list, its holidays, his leave); this reads the rest for that
 * one week and hands it back with the save.
 *
 * It NEVER fails the save: anything it cannot answer exactly — a month the board does not show, a week
 * that is not on it, a newer save already on the week, a read that fails — answers null, and the board
 * reads itself again exactly as it did before.
 */
export async function loadMonthlyWeekAfterSave(
  viewer: PhoenixCrmViewer,
  input: { boardMonth: unknown; saved: SavedPlan; reads: PlanSaveReads },
): Promise<SavedWeekBoard | null> {
  try {
    return await savedWeekBoard(viewer, input);
  } catch (error) {
    logError("Phoenix CRM could not draw the saved week for the plan board", {
      error,
      labels: { event: "phoenix_crm_plan_save_board_unread" },
    });
    return null;
  }
}

async function savedWeekBoard(
  viewer: PhoenixCrmViewer,
  { boardMonth, saved, reads }: { boardMonth: unknown; saved: SavedPlan; reads: PlanSaveReads },
): Promise<SavedWeekBoard | null> {
  const { seat, isTest, weekStart } = reads;
  const today = viewer.cairoToday;
  const now = new Date();
  // The month the board read, exactly as it read it — never one worked out here.
  if (typeof boardMonth !== "string" || !plannableMonths(today).includes(boardMonth)) return null;
  const monthStart = boardMonth;
  const weeks = fieldWeeksOfMonth(monthStart);
  const leadingWeek = boardLeadingWeek(monthStart, today);
  const leading = !weeks.includes(weekStart);
  if (leading && weekStart !== leadingWeek) return null;
  const leadingIsRunning = boardLeadingWeekIsRunning(leadingWeek, today);
  const decidesWeeks = canReviewTerritory(viewer, seat, isTest) || canReturnTerritoryPlan(viewer, seat, isTest);

  // The saved week's row — and, unless it is the leading week, which enters no meter, every other week
  // of the month, whose placements the meters count.
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plans")
    .select(PLAN_COLUMNS)
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .in("week_start", leading ? [weekStart] : weeks);
  throwIfError(error);
  const planRows = (data ?? []) as Row[];
  const planRow = planRows.find((row) => String(row.week_start) === weekStart) ?? null;
  // Another save already on the week (a second tab, a second phone): the board reads it whole.
  if (!planRow || String(planRow.id) !== saved.planId || Number(planRow.version) !== saved.version) return null;
  const planId = String(planRow.id);

  const [itemRows, names, activities, starts, editState, pendingLeave] = await Promise.all([
    loadPlanItemRows(
      planRows.map((row) => String(row.id)),
      ITEM_COLUMNS,
    ),
    loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...planPeople([planRow])]),
    loadPlanActivities([planId]),
    loadPlanDayStarts([planId]),
    loadPlanEditState([planId], isTest),
    // Leave he has asked for and nobody has decided: named on the plan, never a day off (owner, 2026-10-08).
    loadSeatPendingLeave(seat, { from: weekStart, to: addDaysIso(weekStart, 5) }),
  ]);
  const territory = describeTerritory(viewer.org, seat, names);
  const settings = viewer.config.settings;
  const week = buildMonthlyWeekView(
    {
      viewer,
      isTest,
      monthStart,
      today,
      now,
      leadingIsRunning,
      settings,
      isRamadan: (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides),
      names,
      territory,
      editState,
      activities,
      starts,
      // The week's own holidays and leave, read by the save itself over exactly these six days.
      holidays: reads.holidays,
      leave: reads.leave,
      pendingLeave,
      // A save leaves a week a draft or returned, and only a SENT week shows what changed since its last
      // send, so nothing the sends kept is ever drawn here.
      sends: new Map<string, SentEvent[]>(),
      decidesWeeks,
      repForWeeks: canWriteAsRep(viewer, seat, isTest) && Boolean(seat.lineCode),
      reviewerForWeeks: canReviewTerritory(viewer, seat, isTest),
      returnerForWeeks: canReturnTerritoryPlan(viewer, seat, isTest),
    },
    weekStart,
    planRow,
    itemRows.filter((row) => String(row.plan_id) === planId),
    leading,
  );
  if (leading) return { monthStart, week, meters: null };

  // The list the save checked its items against — the board's own list (on-list customers only), in the
  // board's own order, so the tallies come back in the order the board draws them.
  const customers = reads.customers.flatMap((row) => {
    const counted = meterCustomerOf(row, reads.placesByCustomer.get(String(row.id)) ?? []);
    return counted ? [counted] : [];
  });
  customers.sort(byListThenName);
  return { monthStart, week, meters: monthMeters({ monthStart, settings, customers, itemRows }) };
}

// ── Submit / reopen (the rep) ─────────────────────────────────────────────────────────────────────

export type MonthlyTransitionResult = { monthlyPlanId: string; status: PhoenixCrmPlanStatus; version: number };

/**
 * The rep no longer sends or takes back a MONTH (owner, 2026-10-01 — "the plan is entered weekly only").
 * On 1 October four Delta reps pressed "Send the month", were stamped late against a month due on 24
 * September, and went on planning weeks they could not send. The route stays, so a screen one release
 * behind is told what to do instead of meeting a missing page; the gate still runs first, so a viewer
 * who could never have sent a month is refused exactly as before.
 */
export async function transitionMonthlyPlanAsRep(viewer: PhoenixCrmViewer, raw: unknown): Promise<MonthlyTransitionResult> {
  const body = record(raw);
  territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  throw conflictError("Plans are sent one week at a time now. Open your week and press Send this week. Reload the planner.");
}

// ── Approve / return (the reviewer or the SFE Manager) ──────────────────────────────────────────────

export async function decideMonthlyPlan(viewer: PhoenixCrmViewer, raw: unknown): Promise<MonthlyTransitionResult> {
  const body = record(raw);
  if (!isUuid(body.monthlyPlanId)) throw validationError("Choose the plan. Reload the page.");
  const action = body.action === "approve" ? "approve" : body.action === "return" ? "return" : null;
  if (!action) throw validationError("Reload the page and try again.");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("Reload the plan and try again.");
  const note = cleanText(body.note, PLAN_DECISION_NOTE_MAX);
  const monthlyPlanId = String(body.monthlyPlanId).toLowerCase();

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_monthly_plans")
    .select("id, seat_id, month_start, status, is_test, submitted_by_hr_id")
    .eq("id", monthlyPlanId)
    .maybeSingle();
  throwIfError(error);
  const headerRow = data as Row | null;
  if (!headerRow) throw notFoundError("This plan is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(headerRow.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = headerRow.is_test === true;
  const monthStart = String(headerRow.month_start);
  const today = viewer.cairoToday;

  let actorRole: "reviewer" | "sfe_manager" | "administrator";
  let decidedAs: "reviewer" | "sfe" | "administrator" = "reviewer";
  if (action === "approve") {
    // The Administrator may approve a month in the reviewer's place; he is no step (owner, 2026-10-14).
    const asAdministrator = canOverrideDecision(viewer, isTest);
    if (!asAdministrator) assertReviewer(viewer, seat, isTest);
    decidedAs = asAdministrator ? "administrator" : "reviewer";
    actorRole = asAdministrator ? "administrator" : "reviewer";
  } else {
    decidedAs = assertCanReturnPlan(viewer, seat, isTest);
    actorRole = decidedAs === "sfe" ? "sfe_manager" : decidedAs === "administrator" ? "administrator" : "reviewer";
    if (monthEndOf(monthStart) < today) throw conflictError("This month is over, so its plan can no longer be returned. Reload the page.");
    if (!note) throw validationError("Write a note for the rep on what to change.");
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_monthly_plan_transition", {
    p: {
      monthly_plan_id: monthlyPlanId,
      action,
      actor_hr_id: viewer.hrId,
      actor_role: actorRole,
      is_test: isTest,
      expected_version: expectedVersion,
      note,
    },
  });
  const status = statusOf(result.status);
  const version = Number(result.version);
  const repHrIds = [...new Set([textOrNull(result.submitted_by_hr_id), seat.occupantHrId].filter((hrId): hrId is string => Boolean(hrId)))];
  await notifyPhoenixCrm(
    {
      kind: "monthly_plan_decided",
      org: viewer.org,
      seat,
      monthlyPlanId,
      version,
      monthStart: String(result.month_start),
      status: action === "approve" ? "approved" : "returned",
      deciderHrId: viewer.hrId,
      decidedAs,
      repHrIds,
      note,
    },
    isTest,
  );
  return { monthlyPlanId, status, version };
}

// ── The managers' monthly review list ──────────────────────────────────────────────────────────────

export type MonthlyReviewRow = {
  territory: TerritorySummary;
  plan: MonthlyPlanSummary | null;
  doctors: number;
  accounts: number;
  /** Customers placed on a day they do not receive, across the month. */
  exceptions: number;
  staleItems: number;
  /** Days whose customers span more than the far-apart distance. */
  farApartDays: string[];
  canApprove: boolean;
  canReturn: boolean;
};

export type MonthlyReviewView = {
  isTest: boolean;
  monthStart: string;
  /** The plannable months, with the plans waiting for this viewer's decision in each. */
  months: Array<{ monthStart: string; label: string; waiting: number }>;
  rows: MonthlyReviewRow[];
  farApartKm: number;
};

const REVIEW_ORDER: Record<PhoenixCrmPlanStatus | "none", number> = { submitted: 0, returned: 1, draft: 2, none: 3, approved: 4 };

/**
 * One month's plans across the viewer's territories: waiting ones first, with their far-apart days.
 * Territories with no plan show too, so a manager sees who has not sent one. The test world lists the
 * test plans only — read for the Super Admin's "Test accounts" tab (owner, 2026-10-22), which asks for it
 * by name through `read`.
 */
export async function loadMonthlyPlanReviews(
  viewer: PhoenixCrmViewer,
  raw: { test: unknown; month: unknown },
  read?: TestWorldRead,
): Promise<MonthlyReviewView> {
  const isTest = worldFor(viewer, raw.test, read);
  const months = plannableMonths(viewer.cairoToday);
  const monthStart = resolveMonth(raw.month, months);

  const territories = testReadSeats(viewer, isTest, viewer.scopeTerritories);
  const territoryById = new Map(territories.map((seat) => [seat.seatId, seat]));
  const supabase = getSupabaseAdmin();
  const headerQuery = (seatIds: string[] | null) =>
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_monthly_plans").select(MONTHLY_PLAN_COLUMNS).eq("is_test", isTest).in("month_start", months);
        if (seatIds) query = query.in("seat_id", seatIds);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  // The weekly plans of this month's field-weeks, for the doctor and account counts and the far-apart days.
  // The chunks are read a few at a time, never one after another (2026-10-16 speed audit), in chunk order.
  const weeks = fieldWeeksOfMonth(monthStart);
  const planRowsOf = async (seats: ReadonlyArray<OrgSeat>): Promise<Row[]> => {
    const seatIds = seats.map((seat) => seat.seatId);
    if (weeks.length === 0 || seatIds.length === 0) return [];
    const pages = await mapWithConcurrency(chunk(seatIds, 100), PLAN_READ_CONCURRENCY, (part) =>
      fetchAllRowsKeyset<Row>(
        () => supabase.from("phoenix_crm_plans").select("id, seat_id, week_start, is_test").eq("is_test", isTest).in("seat_id", part).in("week_start", weeks),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    );
    return pages.flat();
  };
  // Outside test mode the rows are every territory in scope — known before a header is read — so the
  // weekly plans are read BESIDE the headers rather than after them. A failed header read still
  // surfaces first. Test mode lists only the territories that have a header, so it still waits for them.
  const planRowsEarly = isTest ? null : planRowsOf(territories);
  planRowsEarly?.catch(() => undefined);
  let headerRows: Row[];
  if ((isTest && viewer.isSuperAdmin) || viewer.basis === "all") {
    headerRows = await headerQuery(null);
  } else {
    headerRows = (await mapWithConcurrency(chunk([...territoryById.keys()], 100), PLAN_READ_CONCURRENCY, (part) => headerQuery(part))).flat();
  }
  headerRows = headerRows.filter((row) => territoryById.has(String(row.seat_id)));

  const approves = (row: Row) => canReviewTerritory(viewer, territoryById.get(String(row.seat_id)) as OrgSeat, isTest);
  const waitingByMonth = new Map<string, number>();
  for (const row of headerRows) {
    if (row.status !== "submitted" || !approves(row)) continue;
    const month = String(row.month_start);
    waitingByMonth.set(month, (waitingByMonth.get(month) ?? 0) + 1);
  }

  const monthHeaders = headerRows.filter((row) => String(row.month_start) === monthStart);
  const headerBySeat = new Map(monthHeaders.map((row) => [String(row.seat_id), row]));
  const rowSeats = isTest ? monthHeaders.map((row) => territoryById.get(String(row.seat_id)) as OrgSeat) : territories;

  const planRows = await (planRowsEarly ?? planRowsOf(rowSeats));
  const planSeatById = new Map(planRows.map((row) => [String(row.id), String(row.seat_id)]));

  const [itemRows, names] = await Promise.all([
    loadPlanItemRows(
      planRows.map((row) => String(row.id)),
      REVIEW_ITEM_COLUMNS,
    ),
    loadPeopleNames([...territoryPeople(viewer.org, rowSeats), ...planPeople(monthHeaders)]),
  ]);
  const itemsBySeat = new Map<string, Row[]>();
  for (const row of itemRows) {
    const seatId = planSeatById.get(String(row.plan_id));
    if (!seatId) continue;
    const list = itemsBySeat.get(seatId) ?? [];
    list.push(row);
    itemsBySeat.set(seatId, list);
  }

  const farApartKm = viewer.config.settings.farApartKm;
  const monthOpen = monthEndOf(monthStart) >= viewer.cairoToday;
  const rows = rowSeats.map((seat): MonthlyReviewRow => {
    const items = itemsBySeat.get(seat.seatId) ?? [];
    const byDay = new Map<string, Array<{ id: string; lat: number; lon: number }>>();
    let doctors = 0;
    let accounts = 0;
    let exceptions = 0;
    let staleItems = 0;
    for (const item of items) {
      if (listTypeOf(item.list_type) === "AM") accounts += 1;
      else doctors += 1;
      if (item.receives !== true) exceptions += 1;
      if (isStaleItem(item)) staleItems += 1;
      const place = record(item.place);
      const lat = numberOrNull(place.lat);
      const lon = numberOrNull(place.lon);
      if (lat === null || lon === null) continue;
      const day = String(item.plan_date);
      const points = byDay.get(day) ?? [];
      points.push({ id: String(item.customer_id), lat, lon });
      byDay.set(day, points);
    }
    const farApartDays = [...byDay]
      .filter(([, points]) => checkDaySpread(points, farApartKm).spread)
      .map(([day]) => day)
      .sort();
    const headerRow = headerBySeat.get(seat.seatId) ?? null;
    const rowTerritory = describeTerritory(viewer.org, seat, names);
    const plan = headerRow ? mapMonthlyPlan(headerRow, names, rowTerritory) : null;
    return {
      territory: rowTerritory,
      plan,
      doctors,
      accounts,
      exceptions,
      staleItems,
      farApartDays,
      canApprove: plan?.status === "submitted" && canReviewTerritory(viewer, seat, isTest),
      canReturn: monthOpen && (plan?.status === "submitted" || plan?.status === "approved") && canReturnTerritoryPlan(viewer, seat, isTest),
    };
  });
  rows.sort(
    (left, right) =>
      REVIEW_ORDER[left.plan?.status ?? "none"] - REVIEW_ORDER[right.plan?.status ?? "none"] ||
      left.territory.name.localeCompare(right.territory.name),
  );

  return {
    isTest,
    monthStart,
    months: months.map((month) => ({ monthStart: month, label: formatPhoenixMonth(month), waiting: waitingByMonth.get(month) ?? 0 })),
    rows,
    farApartKm,
  };
}
