/**
 * Phoenix CRM — the weekly plan: the planner, saving, sending for review, and the manager's decision.
 *
 * Owner, 2026-09-16:
 *   - a rep is asked for a weekly plan only once the list is ready: every reference customer validated,
 *     or dropped with the district manager's approval (a territory stamped ready stays ready; a
 *     territory with no reference list is ready but never stamped, so a list that reaches it later is
 *     finished first);
 *   - the rep places the customers and the system only assists: each customer's timings show, the
 *     day's suggestions put uncovered customers first (suggestions.ts, run on the phone from the
 *     planner data), a customer placed on a day his saved hours do not cover is never blocked (owner,
 *     2026-09-30), and customers
 *     far apart on one day are highlighted when the plan reaches the manager;
 *   - a plan day holds at most 15 doctors and 5 accounts (settings) — the plan's only hard limit;
 *   - the district manager approves; the SFE Manager sees every plan and can return one; the system
 *     never approves a plan.
 *
 * The database function saves only the days that have not passed and checks the plan's version, so
 * two screens never overwrite each other (supabase/migrations/20260916150000_phoenix_crm.sql). Once a
 * week is over (after its Thursday, Cairo) its plan stays as it stood: it cannot be sent, reopened or
 * returned, since the rep could no longer act on a return; a late approval still records.
 *
 * Owner, 2026-09-29 — the plan rebuilt as one board: the month on top as Week 1..N, a week's days, a
 * day's customers ticked by brick with its other activities on top.
 *   - a week sent on its own is due the Thursday before it (`weeklyPlanDueOn`); sent with the month it
 *     is judged against the month's own date. A late plan is ACCEPTED and STAMPED, never refused — the
 *     stamp is written by `phoenix_crm_plan_transition` from the server's clock;
 *   - a day can carry one planned activity (a meeting, a conference, a sales day…), saved beside the
 *     day's customers (plan-activities.ts);
 *   - "Copy last month / last week / a day" are drafts built on the phone from `loadPlanCopySource`
 *     and saved through this same `savePlan`, so a copied day passes every rule a ticked one does.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { afterResponse } from "@/lib/http/after-response";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  editablePlanDays,
  fieldWeekDays,
  isFieldWeekStart,
  isIsoDay,
  isRamadanDay,
  monthStartOf,
  planDayListTypes,
  plannableWeeks,
  repPlanWeek,
  weeklyPlanDueOn,
} from "@/lib/phoenix-crm/calendar";
import { summarizeReadiness } from "@/lib/phoenix-crm/coverage";
import { cleanText, parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { checkDaySpread } from "@/lib/phoenix-crm/geo";
import { noDayStarts, parsePlanDayStarts, type PlanDayStarts } from "@/lib/phoenix-crm/plan-day-starts";
import {
  describeDayWindows,
  exceptionLabel,
  isPlanEditable,
  isUuid,
  onlyReturnedDayEditable,
  parsePlanItems,
  PLAN_DECISION_NOTE_MAX,
  planDayLabel,
  planDayOff,
  planSendCapRefusal,
  planStatusLine,
  resolvePlanItems,
  standingReturnedDay,
  type PlanDayOff,
  type PlanRuleCustomer,
} from "@/lib/phoenix-crm/plan-rules";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { sharedPlanCapRefusal } from "@/lib/phoenix-crm/shared-place-rules";
import {
  assertCanReturnPlan,
  assertReviewer,
  canOverrideDecision,
  canReturnTerritoryPlan,
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
import {
  ensureReferenceCustomersRecently,
  loadMonthVisitCounts,
  loadPlannerReferences,
  loadReadiness,
  loadReference,
  loadTerritoryCustomers,
  mapTimings,
  type ListPlace,
} from "@/lib/phoenix-crm/server/list";
import type { SavedWeekBoard } from "@/lib/phoenix-crm/server/monthly-plans";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadOldCrmReviewPlans, type OldCrmReviewPlan } from "@/lib/phoenix-crm/server/old-crm-plan-approval";
import { loadSharedPlaceNames } from "@/lib/phoenix-crm/server/shared-places";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import {
  loadPlanActivities,
  parsePlanActivities,
  savePlanActivities,
  type PlannedActivityRow,
} from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlanDayStarts, savePlanDayStarts } from "@/lib/phoenix-crm/server/plan-day-starts";
import { loadSeatDaysOff, loadSeatPendingLeave } from "@/lib/phoenix-crm/server/leave-days";
import { assertRepMayChangeWeek, editAcknowledgedAt, loadPlanEditState, repStateOf } from "@/lib/phoenix-crm/server/plan-edits";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { loadPlannerInsights } from "@/lib/phoenix-crm/server/plan-insight";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { effectiveListType, type PlannerCustomer, type PlannerInsight, type PlannerPlace } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade, PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// A pharmacy is NEVER planned (owner, 2026-10-02: "He don't plan it. We don't want extra"), so
// nothing in this file — a plan row, a plan's own counts, the customers offered for planning —
// may carry one. null is that refusal, and every caller drops the row.
export function listTypeOf(value: unknown): PhoenixCrmDoctorListType | null {
  return doctorListType(value);
}

export function statusOf(value: unknown): PhoenixCrmPlanStatus {
  return value === "submitted" || value === "approved" || value === "returned" ? value : "draft";
}

// ── Reading plans ───────────────────────────────────────────────────────────────────────────────

// ONE string literal, never joined with `+`: the Supabase client reads the select list at the TYPE level,
// and a joined string is a plain `string`, which types every row as an error (TS2352 in CI, 2026-09-30).
export const PLAN_COLUMNS =
  "id, seat_id, week_start, status, version, submitted_at, submitted_by_hr_id, decided_at, decided_by_hr_id, decided_by_role, decision_note, created_by_hr_id, updated_at, is_test, due_on, submitted_late, submitted_via, returned_day";

/** Each item with its customer and place as they are now, so a customer who left the list shows. */
export const ITEM_COLUMNS =
  "id, plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note, " +
  "customer:phoenix_crm_customers!customer_id(name, grade, speciality, status), " +
  "place:phoenix_crm_places!place_id(label, brick_name, zone, lat, lon, timings, status)";

/**
 * What a SEND re-reads of its whole week (`transitionPlan`): the item's day and list for the AM/PM caps,
 * the customer's and the place's status for the stale test (`isStaleItem`), and the venue the place sits
 * in for the venue cap — on the item's own place, so the send no longer reads the places a second time.
 */
const SEND_ITEM_COLUMNS =
  "id, plan_date, place_id, list_type, " +
  "customer:phoenix_crm_customers!customer_id(status), place:phoenix_crm_places!place_id(status, shared_place_id)";

export const REVIEW_ITEM_COLUMNS =
  "id, plan_id, plan_date, customer_id, list_type, receives, " +
  "customer:phoenix_crm_customers!customer_id(status), place:phoenix_crm_places!place_id(lat, lon, status)";

export type PlanSummary = {
  planId: string;
  weekStart: string;
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
  /** When the week was due: the Thursday before it, or the month's own date when it went with the month. */
  dueOn: string;
  /** Sent after it was due. Stamped from the server's clock at submit; nothing was refused. */
  submittedLate: boolean;
  /** Sent on its own, or as part of the month. Null until sent. */
  submittedVia: "week" | "month" | null;
  /**
   * The ONE day a reviewer returned, as stored (owner, 2026-10-02: "Only that day" reopens) — null for a
   * week returned whole and every week that is not returned. Whether it still stands, or was lifted by
   * an acknowledged edit, is `standingReturnedDay` (plan-rules.ts).
   */
  returnedDay: string | null;
};

export function planPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [textOrNull(row.submitted_by_hr_id), textOrNull(row.decided_by_hr_id)]);
}

/**
 * 🔴 `people` IS WHAT PUTS THE NAMES IN THE STATUS (owner, 2026-10-08) — the rep and the manager above
 * the territory, which every caller already has from `describeTerritory`. Left out, the status falls
 * back to the bare word, so an old caller is wrong-free rather than saying "waiting for null".
 */
export function mapPlan(row: Row, names: PeopleNames, people?: { repName: string | null; reviewerName: string | null; self?: boolean }): PlanSummary {
  const status = statusOf(row.status);
  const submittedBy = textOrNull(row.submitted_by_hr_id);
  const decidedBy = textOrNull(row.decided_by_hr_id);
  return {
    planId: String(row.id),
    weekStart: String(row.week_start),
    status,
    statusLabel: planStatusLine({
      status,
      repName: people?.repName ?? null,
      reviewerName: people?.reviewerName ?? null,
      deciderName: decidedBy ? nameOf(names, decidedBy) : null,
      self: people?.self,
    }),
    version: Number(row.version),
    submittedAt: textOrNull(row.submitted_at),
    submittedByName: submittedBy ? nameOf(names, submittedBy) : null,
    decidedAt: textOrNull(row.decided_at),
    decidedByName: decidedBy ? nameOf(names, decidedBy) : null,
    decidedBySfe: row.decided_by_role === "sfe_manager",
    decisionNote: textOrNull(row.decision_note),
    updatedAt: String(row.updated_at),
    dueOn: textOrNull(row.due_on) ?? weeklyPlanDueOn(String(row.week_start)),
    submittedLate: row.submitted_late === true,
    submittedVia: row.submitted_via === "week" || row.submitted_via === "month" ? row.submitted_via : null,
    returnedDay: status === "returned" ? textOrNull(row.returned_day) : null,
  };
}

/** How many chunked reads one loader keeps in flight at once (2026-10-16 speed audit). */
export const PLAN_READ_CONCURRENCY = 4;

/**
 * Every item of these plans, in chunks of 50 plans — read a few chunks at a time rather than one after
 * another (2026-10-16 speed audit: a review list over many territories waited on each chunk in turn).
 * The rows come back in chunk order, exactly as the one-at-a-time loop returned them.
 */
export async function loadPlanItemRows(planIds: ReadonlyArray<string>, columns: string): Promise<Row[]> {
  const pages = await mapWithConcurrency(chunk([...new Set(planIds)], 50), PLAN_READ_CONCURRENCY, (part) =>
    fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_plan_items").select(columns).in("plan_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  return pages.flat();
}

/**
 * A planned customer who has left the list since, or whose planned place was removed. A customer who
 * is not validated yet is NOT stale — he is planned on purpose, and stale blocks submitting.
 */
export function isStaleItem(row: Row): boolean {
  const status = record(row.customer).status;
  if (status !== "active" && status !== "pending") return true;
  // He has no place, so there is no place to have been removed.
  if (row.place === null || row.place === undefined) return false;
  return record(row.place).status !== "active";
}

/**
 * The building each seated place sits in, by name, so the plan can say WHICH polyclinic or centre a
 * customer is in (owner, 2026-10-10). Wording only: no cap ever depends on this read. The week planner,
 * the month board and the save all ask it of the same places, so it is asked one way.
 */
export function venueNamesOf(placesByCustomer: ReadonlyMap<string, ReadonlyArray<Pick<ListPlace, "sharedPlaceId">>>) {
  return loadSharedPlaceNames([...placesByCustomer.values()].flatMap((list) => list.map((place) => place.sharedPlaceId ?? null)));
}

export type TerritoryReadiness = { ready: boolean; total: number; open: number; dropPending: number };

export async function territoryReadiness(seatId: string, isTest: boolean, markReady: boolean): Promise<TerritoryReadiness> {
  if (isTest) {
    const summary = summarizeReadiness((await loadReference(seatId, true)).map((row) => row.state));
    return { ready: summary.ready, total: summary.total, open: summary.open, dropPending: summary.dropPending };
  }
  const entry = (await loadReadiness([seatId], markReady)).get(seatId);
  // The readiness function answers for every seat it is asked about, so a missing answer is a fault:
  // it keeps the planner closed rather than opening a territory whose list was never measured.
  if (!entry) return { ready: false, total: 0, open: 0, dropPending: 0 };
  return { ready: entry.ready, total: entry.total, open: entry.open, dropPending: entry.dropPending };
}

// ── The planner ─────────────────────────────────────────────────────────────────────────────────

export type PlanItemView = {
  customerId: string;
  /** Null for a customer who is not validated yet: he is planned without a place. */
  placeId: string | null;
  /** Carried over from iReports360 and not validated yet. Plannable, visitable, counted in nothing. */
  pending: boolean;
  name: string;
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  placeLabel: string | null;
  brickName: string | null;
  zone: string | null;
  receives: boolean;
  /** "6:00 PM – 8:00 PM", or "Does not receive this day". */
  windowsText: string;
  startMinute: number | null;
  exceptionType: string | null;
  exceptionLabel: string | null;
  exceptionNote: string | null;
  /** Left the list, or the place was removed, after it was planned: the rep replaces it. */
  stale: boolean;
  /** Even the nearest other customer of the day is further than the far-apart distance. */
  isolated: boolean;
  nearestKm: number | null;
};

export type PlanDayView = {
  date: string;
  /** Empty on a day off (`dayOff`), as on a Friday: the day holds no customer. */
  listTypes: PhoenixCrmDoctorListType[];
  /** The public holiday this day is, by name — "Armed Forces Day" — or null on a working day. */
  holiday: string | null;
  /**
   * The day off this day is — the public holiday, or a full day of the rep's own approved leave
   * ("Annual Vacation", owner 2026-10-02) — or null on a working day. One path for both: greyed in the
   * day picker, skipped by Suggest, every copy and "Next day", and refused by a save.
   */
  dayOff: PlanDayOff | null;
  /**
   * A leave the rep has asked for on this day that nobody has decided yet — "Annual Vacation" — or null
   * (owner, 2026-10-08). Information only: the day stays plannable and nothing is refused over it; once
   * HR approves it the day becomes a `dayOff` by itself. Never set on a day that is already a day off.
   */
  pendingLeave: string | null;
  ramadan: boolean;
  /** Today or later: the rep may still change it. */
  editable: boolean;
  /** The other activities planned for the day (a meeting, a sales day…), one of each kind, shown at the top of it. */
  activities: PlannedActivityRow[];
  /** The first of `activities` — what this field carried while a day held one; kept for a caller one release behind. */
  activity: PlannedActivityRow | null;
  /** When the rep means to start his AM and his PM rounds that day — his own statement, never a rule. */
  starts: PlanDayStarts;
  items: PlanItemView[];
  counts: Record<PhoenixCrmDoctorListType, number>;
  spanKm: number;
  /** The day's customers span more than the far-apart distance (highlighted to the reviewer). */
  farApart: boolean;
};

export type PlannerView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  weekStart: string;
  weeks: Array<{ weekStart: string; status: PhoenixCrmPlanStatus | null; statusLabel: string }>;
  readiness: TerritoryReadiness;
  /** Customers carried over from iReports360 and not validated yet. Information, never a refusal. */
  pendingCount: number;
  rules: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap" | "farApartKm" | "gradeTargets">;
  plan: PlanSummary | null;
  days: PlanDayView[];
  /** The validated list with places and timings, for the day's suggestions on the phone. */
  customers: PlannerCustomer[];
  viewerIsRep: boolean;
  viewerIsReviewer: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canReopen: boolean;
  canApprove: boolean;
  canReturn: boolean;
  /** Why the rep cannot plan this week, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
  /** The ONE day a reviewer returned while it stands (owner, 2026-10-02) — every other day is fixed. */
  returnedDay: string | null;
};

export function buildDays(input: {
  weekStart: string;
  cairoToday: string;
  itemRows: ReadonlyArray<Row>;
  farApartKm: number;
  isRamadan: (isoDay: string) => boolean;
  activities?: ReadonlyMap<string, PlannedActivityRow[]>;
  starts?: ReadonlyMap<string, PlanDayStarts>;
  /** The public holidays of the week, `day → name` (plan-holidays.ts). A day named here holds no customer. */
  holidays?: ReadonlyMap<string, string>;
  /** The rep's own full days of approved leave, `day → name` (leave-days.ts `loadSeatDaysOff`). Days off too. */
  leave?: ReadonlyMap<string, string>;
  /** Leave the rep has asked for and nobody has decided, `day → name` (leave-days.ts `loadSeatPendingLeave`). Shown, never a day off. */
  pendingLeave?: ReadonlyMap<string, string>;
}): PlanDayView[] {
  const byDay = new Map<string, Row[]>();
  for (const row of input.itemRows) {
    const date = String(row.plan_date);
    const list = byDay.get(date) ?? [];
    list.push(row);
    byDay.set(date, list);
  }

  return fieldWeekDays(input.weekStart).map((date) => {
    const ramadan = input.isRamadan(date);
    const rows = byDay.get(date) ?? [];
    const points = rows.flatMap((row) => {
      const place = record(row.place);
      const lat = numberOrNull(place.lat);
      const lon = numberOrNull(place.lon);
      return lat === null || lon === null ? [] : [{ id: String(row.customer_id), lat, lon }];
    });
    const spread = checkDaySpread(points, input.farApartKm);
    const isolated = new Set(spread.isolatedIds);
    const counts: Record<PhoenixCrmDoctorListType, number> = { AM: 0, PM: 0 };

    const items = rows.flatMap((row): PlanItemView[] => {
      const customer = record(row.customer);
      const place = record(row.place);
      const customerId = String(row.customer_id);
      // A plan row naming a pharmacy cannot exist (one is never planned), and if one ever did
      // it would not be a plan item — it is dropped rather than counted among the doctors.
      const listType = listTypeOf(row.list_type);
      if (listType === null) return [];
      counts[listType] += 1;
      const exceptionType = textOrNull(row.exception_type);
      const nearest = spread.nearestKmById[customerId];
      const pending = customer.status === "pending";
      return [{
        customerId,
        placeId: textOrNull(row.place_id),
        pending,
        name: textOrNull(customer.name) ?? "Customer",
        listType,
        grade: parseGrade(customer.grade),
        speciality: textOrNull(customer.speciality),
        placeLabel: textOrNull(place.label),
        brickName: textOrNull(place.brick_name),
        zone: textOrNull(place.zone),
        receives: row.receives === true,
        // No place means nothing is known about when he receives — never "does not receive this day".
        windowsText: row.place ? describeDayWindows(mapTimings(place.timings), date, ramadan) : "No days and hours yet",
        startMinute: numberOrNull(row.start_minute),
        exceptionType,
        exceptionLabel: exceptionLabel(exceptionType),
        exceptionNote: textOrNull(row.exception_note),
        stale: isStaleItem(row),
        isolated: isolated.has(customerId),
        nearestKm: nearest === undefined || !Number.isFinite(nearest) ? null : Math.round(nearest * 10) / 10,
      }];
    });
    items.sort(
      (left, right) =>
        left.listType.localeCompare(right.listType) ||
        (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
        left.name.localeCompare(right.name),
    );

    const activities = input.activities?.get(date) ?? [];
    const holiday = input.holidays?.get(date) ?? null;
    const dayOff = planDayOff(date, input.holidays, input.leave);
    return {
      date,
      listTypes: dayOff ? [] : planDayListTypes(date),
      holiday,
      dayOff,
      // A day that is already a day off says that, not "pending": approved leave and a holiday outrank a request.
      pendingLeave: dayOff ? null : (input.pendingLeave?.get(date) ?? null),
      ramadan,
      editable: date >= input.cairoToday,
      activities,
      activity: activities[0] ?? null,
      starts: input.starts?.get(date) ?? noDayStarts(),
      items,
      counts,
      spanKm: spread.spanKm,
      farApart: spread.spread,
    };
  });
}

export async function loadPlanner(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown; weekStart: unknown }): Promise<PlannerView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.cairoToday;
  const weeks = plannableWeeks(today);
  const weekStart = isFieldWeekStart(raw.weekStart) ? raw.weekStart : weeks[0];
  const weekList = weeks.includes(weekStart) ? weeks : [weekStart, ...weeks];

  // 🔴 TWO CHAINS SIDE BY SIDE, NOT THREE WAVES IN A ROW (2026-10-01, "slow to transfer between page
  // and page", Phoenix CRM first). The planner waited for the reference mint, then for four reads,
  // then for five more — each wave for its slowest member. What truly waits on what is narrower:
  //   • the customer list and the readiness count read the reference list, which the mint can change,
  //     so they still follow it, and the references follow the customer list;
  //   • the week's plan rows cannot name a customer minted a moment ago, and neither can this month's
  //     visit counts, so they start beside the mint — and the plan's items, activities, starts and
  //     names need only the plan rows, so they follow those rather than the whole first wave.
  // Every answer is the one the waves gave. The mint's own failure is still the one that surfaces,
  // first, and every read started early is handled the moment it starts.
  // The mint itself runs at most once per seat in five minutes (2026-10-23, every page change under 1
  // second): a seat minted inside that window answers at once, so the customer list starts without
  // waiting a hop on a mint that would find nothing new. The first open still mints before it reads.
  const ensured = ensureReferenceCustomersRecently(seat, isTest);
  const viewerIsRep = canWriteAsRep(viewer, seat, isTest);
  const planRowsRead = (async () => {
    const planRowsResult = await getSupabaseAdmin()
      .from("phoenix_crm_plans")
      .select(PLAN_COLUMNS)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .in("week_start", weekList);
    throwIfError(planRowsResult.error);
    return (planRowsResult.data ?? []) as Row[];
  })();
  const planPartsRead = planRowsRead.then(async (planRows) => {
    const planRow = planRows.find((row) => String(row.week_start) === weekStart) ?? null;
    // One week at a time (owner, 2026-10-01): the week's requests answer the same question the server
    // asks of a save or a send. A week returned for ONE day reads its requests too: an acknowledged edit
    // after the return opens all of it. Known from the plan row alone, so read beside the items rather
    // than after the whole wave (2026-10-16 speed audit).
    const planStatus = planRow ? statusOf(planRow.status) : null;
    const readsEdit =
      planRow !== null && ((viewerIsRep && planStatus === "draft") || (planStatus === "returned" && Boolean(textOrNull(planRow.returned_day))));
    const [itemRows, names, activities, starts, editState] = await Promise.all([
      planRow ? loadPlanItemRows([String(planRow.id)], ITEM_COLUMNS) : Promise.resolve([] as Row[]),
      loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...planPeople(planRows)]),
      loadPlanActivities(planRow ? [String(planRow.id)] : []),
      loadPlanDayStarts(planRow ? [String(planRow.id)] : []),
      readsEdit && planRow ? loadPlanEditState([String(planRow.id)], isTest, { names: false }) : Promise.resolve(null),
    ]);
    const edit = planRow && editState ? (editState.get(String(planRow.id)) ?? null) : null;
    return { planRows, planRow, itemRows, names, activities, starts, edit };
  });
  const customersRead = ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }));
  const wave = Promise.all([
    planPartsRead,
    customersRead,
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    ensured.then(() => territoryReadiness(seat.seatId, isTest, false)),
    customersRead.then(({ customers }) => loadPlannerReferences(seat.seatId, isTest, customers)),
    loadPlanHolidays(weekStart, addDaysIso(weekStart, 5)),
    // Last seen, the usual days and a follow-up due (owner, 2026-10-02): its Phoenix visits start now,
    // and only its iReports360 half follows the customer list — never a wave of its own. Only the rep
    // plans from them, so a reviewer's board reads none.
    canWriteAsRep(viewer, seat, isTest) ? loadPlannerInsights(seat.seatId, isTest, today, customersRead) : Promise.resolve(new Map<string, PlannerInsight>()),
    // The rep's own full days of approved leave are days off too (owner, 2026-10-02).
    loadSeatDaysOff(seat, { from: weekStart, to: addDaysIso(weekStart, 5) }),
    // Leave he has asked for and nobody has decided: named on the plan, never a day off (owner, 2026-10-08).
    loadSeatPendingLeave(seat, { from: weekStart, to: addDaysIso(weekStart, 5) }),
    // The building each seated place sits in, by name, so the plan can say WHICH polyclinic or centre a
    // customer is in (owner, 2026-10-10). Wording only: the cap never depends on this read. It needs the
    // places alone, so it follows the customer list inside the wave, never after it (2026-10-16).
    customersRead.then(({ placesByCustomer }) => venueNamesOf(placesByCustomer)),
  ]);
  wave.catch(() => undefined);
  await ensured;
  const [
    { planRows, planRow, itemRows, names, activities, starts, edit },
    { customers, placesByCustomer },
    visitCounts,
    readiness,
    references,
    holidays,
    insights,
    leave,
    pendingLeave,
    venueNames,
  ] = await wave;

  const settings = viewer.config.settings;
  const isRamadan = (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides);
  const territory = describeTerritory(viewer.org, seat, names);
  // His own planner says "you" — the rep reading "Drafted by Ahmed Samir" on Ahmed Samir's screen.
  const selfReader = seat.occupantHrId === viewer.hrId;
  const plan = planRow ? mapPlan(planRow, names, { ...territory, self: selfReader }) : null;
  const weekDays = buildDays({ weekStart, cairoToday: today, itemRows, farApartKm: settings.farApartKm, isRamadan, activities, starts, holidays, leave, pendingLeave });

  const plannerCustomers: PlannerCustomer[] = customers.flatMap((row) => {
    const customerId = String(row.id);
    // A pharmacy is never planned, so it is not offered to the planner at all.
    const listType = listTypeOf(row.list_type);
    if (listType === null) return [];
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
    return {
      customerId,
      name: String(row.name),
      // A seated customer is planned and counted in the session of his seating (owner, 2026-10-10).
      listType: effectiveListType(listType, places),
      grade: parseGrade(row.grade),
      speciality: textOrNull(row.speciality),
      visitsThisMonth: visitCounts.get(customerId) ?? 0,
      pending: row.status === "pending",
      reference: references.get(customerId) ?? null,
      insight: insights.get(customerId) ?? null,
      places,
    };
  });
  plannerCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  const viewerIsReviewer = canReviewTerritory(viewer, seat, isTest);
  const weekOpen = weeks.includes(weekStart) && editablePlanDays(weekStart, today).length > 0;
  const status = plan?.status ?? null;
  // One week at a time (owner, 2026-10-01): the same answer the server gives a save or a send — `edit`
  // is the week's requests, read with its items above.
  const repState = viewerIsRep ? repStateOf({ weekStart, cairoToday: today, status, edit }) : "closed";
  // Only that day is the rep's to change (owner, 2026-10-02) — the same days `savePlan` accepts.
  const returnedDay = standingReturnedDay({
    status,
    returnedDay: plan?.returnedDay ?? null,
    decidedAt: plan?.decidedAt ?? null,
    editAcknowledgedAt: editAcknowledgedAt(edit),
  });
  const days = onlyReturnedDayEditable(weekDays, returnedDay);
  let blockedReason: string | null = null;
  if (viewerIsRep) {
    // Owner, 2026-09-22: nothing about the list ever stops a rep planning. Only the week itself and a
    // territory with no line can, and neither is about the customers on it.
    if (!weekOpen) blockedReason = "This week has passed. Choose a week ahead to plan.";
    else if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so it cannot be planned.";
    else if (repState === "closed") blockedReason = `You plan one week at a time: the week starting ${formatPhoenixLongDate(repPlanWeek(today))}.`;
  }
  const itemCount = itemRows.length;
  const staleOnOpenDays = days.some((day) => day.editable && day.items.some((item) => item.stale));

  return {
    territory,
    isTest,
    cairoToday: today,
    weekStart,
    weeks: weekList.map((week) => {
      const row = planRows.find((entry) => String(entry.week_start) === week);
      const weekStatus = row ? statusOf(row.status) : null;
      const decidedBy = row ? textOrNull(row.decided_by_hr_id) : null;
      return {
        weekStart: week,
        status: weekStatus,
        // The picker reads the same words as the pill it opens, names included — a week that said
        // "Approved" there and "Approved by Dr Taha" once opened is one status in two voices.
        statusLabel: planStatusLine({
          status: weekStatus,
          repName: territory.repName,
          reviewerName: territory.reviewerName,
          deciderName: decidedBy ? nameOf(names, decidedBy) : null,
          self: selfReader,
        }),
      };
    }),
    readiness,
    pendingCount: plannerCustomers.filter((row) => row.pending).length,
    rules: {
      pmDailyCap: settings.pmDailyCap,
      amDailyCap: settings.amDailyCap,
      farApartKm: settings.farApartKm,
      gradeTargets: settings.gradeTargets,
    },
    plan,
    days,
    customers: plannerCustomers,
    viewerIsRep,
    viewerIsReviewer,
    canEdit: viewerIsRep && blockedReason === null && repState === "plan",
    canSubmit: viewerIsRep && blockedReason === null && repState === "plan" && status !== null && isPlanEditable(status) && itemCount > 0 && !staleOnOpenDays,
    // A sent week is changed through "Ask to edit this week" now, never taken back by the rep.
    canReopen: false,
    // The Administrator may approve in the reviewer's place; this flag opens the decision block only,
    // and the review list's own `canApprove` (what is counted as waiting) still leaves him out.
    canApprove: (viewerIsReviewer || canOverrideDecision(viewer, isTest)) && status === "submitted",
    canReturn: weekOpen && canReturnTerritoryPlan(viewer, seat, isTest) && (status === "submitted" || status === "approved"),
    blockedReason,
    returnedDay,
  };
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

/**
 * What a save answers. `board` is there only when the save was asked for it (`boardMonth`, from the
 * rep's own board as it saves itself): the week it just saved and the month's meters, as the month board
 * draws them (monthly-plans.ts `loadMonthlyWeekAfterSave`), so the board reads nothing again after a
 * save. Absent or null, the board reads itself again exactly as before.
 */
export type SavedPlan = { planId: string; status: PhoenixCrmPlanStatus; version: number; itemCount: number; board?: SavedWeekBoard | null };

/**
 * What a save already read on its way — handed to the board's answer after it, so none of it is read a
 * second time. SERVER-SIDE ONLY: it carries the territory's customer rows, and is never sent.
 */
export type PlanSaveReads = {
  seat: OrgSeat;
  isTest: boolean;
  weekStart: string;
  customers: Row[];
  placesByCustomer: Map<string, ListPlace[]>;
  holidays: Map<string, string>;
  leave: Map<string, string>;
};

function lineCodeOf(seat: OrgSeat): string {
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so it cannot be planned.");
  return seat.lineCode;
}

/**
 * Saves the days of a week that have not passed. The phone sends every item of those days; an item it
 * leaves out is taken off the plan. The days that have passed keep what was saved.
 *
 * `keep`, when a caller passes one, is handed what the save read (`PlanSaveReads`) once the save has
 * landed — the route's way to answer with the board without reading any of it again.
 */
export async function savePlan(viewer: PhoenixCrmViewer, raw: unknown, keep?: { reads: PlanSaveReads | null }): Promise<SavedPlan> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const today = viewer.cairoToday;
  if (!isFieldWeekStart(body.weekStart) || !plannableWeeks(today).includes(body.weekStart)) {
    throw validationError("Choose a week to plan from the list. Reload the planner.");
  }
  const weekStart = body.weekStart;
  if (editablePlanDays(weekStart, today).length === 0) throw conflictError("This week has passed. Reload the planner.");

  // 🔴 READ BESIDE THE GUARD, NEVER AFTER IT (2026-10-16 speed audit). The list, the week's holidays and
  // his leave do not depend on the guard's answer — only what is done with them does — so they start
  // now, and are awaited only once every refusal below has had its turn: the guard's own refusal still
  // surfaces first, then the item checks, then a failed read. The venue names need the places alone, so
  // they follow the list rather than waiting for the whole first wave.
  const customersRead = loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true });
  const reads = Promise.all([
    customersRead,
    loadPlanHolidays(weekStart, addDaysIso(weekStart, 5)),
    loadSeatDaysOff(seat, { from: weekStart, to: addDaysIso(weekStart, 5) }),
    // Three visits a day inside one polyclinic (owner, 2026-10-09) — the names only, so the refusal can
    // say "Nile Polyclinic". The COUNT is off the plan's own items, so this read can never widen the cap.
    customersRead.then(({ placesByCustomer }) => venueNamesOf(placesByCustomer)),
  ]);
  reads.catch(() => undefined);

  // 🔴 One week at a time (owner, 2026-10-01): the week he plans now, or one his manager returned or
  // an edit request reopened. A week ahead, a passed one, or a sent one is refused here as well as
  // greyed on the board. Its answer is the ONLY list of days this save may touch: every day from today
  // on — or, when his manager returned ONE day (owner, 2026-10-02: "Only that day"), that day alone.
  const access = await assertRepMayChangeWeek(viewer, seat, isTest, weekStart);
  const editableDays = access.editableDays;
  if (access.returnedDay && editableDays.length === 0) {
    throw conflictError(`${planDayLabel(access.returnedDay)}, the day your manager returned, has passed. Send the week again as it is.`);
  }

  // Stamps the territory ready the first time its list is complete; it then stays ready. It is a
  // progress mark for the manager's Team tab, it has never refused a plan since 2026-09-22, and nothing
  // the save answers reads it — so it runs once the answer has gone (2026-10-16 speed audit).
  if (!isTest) await afterResponse("phoenix_crm_plan_save_readiness_stamp", () => territoryReadiness(seat.seatId, false, true));

  const drafts = parsePlanItems(body.items);
  if (!drafts.ok) throw validationError(drafts.error);
  const open = new Set(editableDays);
  if (drafts.value.some((item) => !open.has(item.planDate))) {
    throw conflictError(
      access.returnedDay
        ? `Only ${planDayLabel(access.returnedDay)} was returned to you. The other days stay as you sent them. Reload the planner.`
        : "A day that has passed cannot be changed. Reload the planner.",
    );
  }

  const [{ customers, placesByCustomer }, holidays, leave, planVenues] = await reads;
  const ruleCustomers = new Map<string, PlanRuleCustomer>(
    customers.flatMap((row): Array<[string, PlanRuleCustomer]> => {
      const customerId = String(row.id);
      // Same reason: a pharmacy never reaches the plan rules, so it is not one of their customers.
      const listType = listTypeOf(row.list_type);
      if (listType === null) return [];
      return [
        [
        customerId,
        {
          customerId,
          name: String(row.name),
          listType,
          pending: row.status === "pending",
          places: (placesByCustomer.get(customerId) ?? []).map((place) => ({
            placeId: place.placeId,
            timings: place.timings,
            sharedPlaceId: place.sharedPlaceId ?? null,
            session: place.session ?? null,
          })),
        },
        ],
      ];
    }),
  );
  const resolved = resolvePlanItems({
    weekStart,
    items: drafts.value,
    customers: ruleCustomers,
    settings: viewer.config.settings,
    isRamadan: (isoDay) => isRamadanDay(isoDay, viewer.config.ramadanOverrides),
    holidays,
    leave,
    sharedPlaces: planVenues,
  });
  if (!resolved.ok) throw validationError(resolved.error);

  const expectedRaw = body.expectedVersion;
  const expectedVersion = expectedRaw === null || expectedRaw === undefined || expectedRaw === "" ? null : Number(expectedRaw);
  if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
    throw validationError("Reload the planner and try again.");
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_save_plan", {
    p: {
      seat_id: seat.seatId,
      line_code: lineCode,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      week_start: weekStart,
      expected_version: expectedVersion,
      editable_days: editableDays,
      items: resolved.value.map((item) => ({
        plan_date: item.planDate,
        customer_id: item.customerId,
        place_id: item.placeId,
        list_type: item.listType,
        receives: item.receives,
        start_minute: item.startMinute,
        exception_type: item.exceptionType,
        exception_note: item.exceptionNote,
      })),
    },
  });
  // The day's other activities ride on the same save, once the plan row exists. A caller that sends
  // none (one release behind) leaves them exactly as they were. So do its Start AM / Start PM, on the
  // same terms: a caller that sends none leaves them as they were.
  //
  // The two are sent TOGETHER (2026-10-16 speed audit): different tables, each its own function under
  // the week's own lock, so the database still takes them one after the other — the phone just stops
  // waiting for one answer before it asks the second. A refusal reads exactly as before: the
  // activities' first, then the starts'.
  const [activitiesSaved, startsSaved] = await Promise.allSettled([
    Array.isArray(body.activities)
      ? savePlanActivities({
          seatId: seat.seatId,
          actorHrId: viewer.hrId,
          isTest,
          weekStart,
          editableDays,
          activities: parsePlanActivities(body.activities, open),
        })
      : Promise.resolve(null),
    Array.isArray(body.starts)
      ? savePlanDayStarts({
          seatId: seat.seatId,
          actorHrId: viewer.hrId,
          isTest,
          weekStart,
          editableDays,
          starts: parsePlanDayStarts(body.starts, open),
        })
      : Promise.resolve(null),
  ]);
  if (activitiesSaved.status === "rejected") throw activitiesSaved.reason;
  if (startsSaved.status === "rejected") throw startsSaved.reason;
  if (keep) keep.reads = { seat, isTest, weekStart, customers, placesByCustomer, holidays, leave };
  return {
    planId: String(result.plan_id),
    status: statusOf(result.status),
    version: Number(result.version),
    itemCount: Number(result.item_count),
  };
}

// ── Sending, reopening and deciding ─────────────────────────────────────────────────────────────

type PlanAction = "submit" | "reopen" | "approve" | "return";

function parseAction(value: unknown): PlanAction | null {
  return value === "submit" || value === "reopen" || value === "approve" || value === "return" ? value : null;
}

export async function transitionPlan(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ planId: string; status: PhoenixCrmPlanStatus; version: number }> {
  const body = record(raw);
  if (!isUuid(body.planId)) throw validationError("Choose the plan. Reload the page.");
  const action = parseAction(body.action);
  if (!action) throw validationError("Reload the page and try again.");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("Reload the plan and try again.");
  const note = cleanText(body.note, PLAN_DECISION_NOTE_MAX);
  const planId = String(body.planId).toLowerCase();
  // ONE day of the week (owner, 2026-10-02: "Only that day" reopens): a return may name it, nothing else.
  const dayRaw = body.day === null || body.day === undefined || body.day === "" ? null : body.day;
  if (dayRaw !== null && !isIsoDay(dayRaw)) throw validationError("Choose the day to return. Reload the page.");
  const day: string | null = dayRaw === null ? null : String(dayRaw);
  if (day !== null && action !== "return") throw validationError("Only a return names a day. Reload the page.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("phoenix_crm_plans")
    // `decided_by_hr_id` / `decided_by_role` are read for ONE reason: a send has to know whether the
    // SFE Manager is the person who returned this week, so he can be told it came back (2026-10-08).
    // They must be read BEFORE the transition — `submit` clears the decision off the row.
    // `returned_day` / `decided_at` are what the one-week guard reads (plan-edits.ts
    // `assertRepMayChangeWeek`), so a send hands it this row instead of reading the plan twice.
    .select("id, seat_id, week_start, status, is_test, decided_by_hr_id, decided_by_role, returned_day, decided_at")
    .eq("id", planId)
    .maybeSingle();
  throwIfError(error);
  const planRow = data as Row | null;
  if (!planRow) throw notFoundError("This plan is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(planRow.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = planRow.is_test === true;
  const today = viewer.cairoToday;

  let actorRole: "rep" | "reviewer" | "sfe_manager" | "administrator";
  let decidedAs: "reviewer" | "sfe" | "administrator" = "reviewer";
  if (action === "submit" || action === "reopen") {
    // The gate ANSWERS with the world this viewer writes in, and the plan found by id must be in it. A
    // test login always writes the test world, so a REAL plan reached by its id is not his to submit or
    // reopen — refused as if it were not there (risk review, 2026-09-28).
    if (territoryForRepWrite(viewer, seat.seatId, isTest).isTest !== isTest) {
      throw notFoundError("This plan is no longer there. Reload the page.");
    }
    actorRole = "rep";
    // Owner, 2026-10-01: a sent week is no longer taken back by the rep — he asks to edit it, and the
    // district manager, SFE and HR open it for him (plan-edits.ts). A phone one release behind still
    // posts "reopen"; it is told what to press instead.
    if (action === "reopen") {
      throw conflictError("A sent week is no longer taken back. Open it and press Ask to edit this week.");
    }
    if (editablePlanDays(String(planRow.week_start), today).length === 0) {
      throw conflictError("This week has passed. Reload the planner.");
    }
    // 🔴 THE WEEK'S OWN ITEMS, NOT THE LAST SAVE'S PAYLOAD. `savePlan` checks the caps against the
    // items one save carries, which covers only the days that save touched — so a day written by an
    // earlier path, or under an earlier cap, was never counted and the send promoted it to the
    // manager unchecked (production, 2026-10-03: an approved week holding 18 PM against a cap of 15).
    // Read every row ONCE, and never narrow this read back to the changeable days: the stale test
    // below wants only those, the cap re-check wants the whole week.
    //
    // Started BESIDE the one-week guard (2026-10-16 speed audit): the rows do not depend on its answer,
    // only what is done with them does, and its refusal still surfaces first.
    const allRowsRead = loadPlanItemRows([planId], SEND_ITEM_COLUMNS);
    allRowsRead.catch(() => undefined);
    const access = await assertRepMayChangeWeek(viewer, seat, isTest, String(planRow.week_start), planRow);
    if (action === "submit") {
      const allRows = await allRowsRead;
      // Only the days he could change answer to this check: a day his manager returned alone is his to
      // fix, and the days left exactly as he sent them are not (owner, 2026-10-02).
      const changeable = new Set(access.editableDays);
      const openRows = allRows.filter((row) => changeable.has(String(row.plan_date)));
      if (openRows.some(isStaleItem)) {
        throw conflictError("A planned customer left your list or changed place. Take it off the plan, save, then send.");
      }
      // The caps, re-read from the whole week and refusable only on a day he can still change — one
      // rule with the save (`planSendCapRefusal` → `planCapRefusal`), never a second copy of it.
      const overCap = planSendCapRefusal({
        items: allRows.flatMap((row) => {
          const listType = listTypeOf(row.list_type);
          return listType ? [{ planDate: String(row.plan_date), listType }] : [];
        }),
        settings: viewer.config.settings,
        changeableDays: access.editableDays,
      });
      if (overCap) throw conflictError(overCap);
      // 🔴 AND THE VENUE CAP ON THE SAME WHOLE WEEK (owner, 2026-10-09: it bites at the plan AND at
      // the door). A stored item carries a `place_id` and nothing about the building behind it, so the
      // venue rides on the item's own place (`SEND_ITEM_COLUMNS`); `onlyDays` is the days he can still
      // change, for the reason the AM/PM re-check above gives — an over-cap day that has passed would
      // deadlock the week.
      const venueCheck = {
        cap: viewer.config.settings.sharedPlaceDailyCap,
        dayLabel: planDayLabel,
        forSend: true,
        items: allRows.map((row) => ({
          planDate: String(row.plan_date),
          sharedPlaceId: textOrNull(record(row.place).shared_place_id),
        })),
        onlyDays: access.editableDays,
      };
      // Whether a day is over is the COUNT alone; the names only word the refusal. So they are read
      // only when there is a refusal to word (2026-10-16 speed audit) — the sentence is the same one.
      const overVenue =
        sharedPlanCapRefusal({ ...venueCheck, venues: new Map() }) === null
          ? null
          : sharedPlanCapRefusal({ ...venueCheck, venues: await loadSharedPlaceNames(venueCheck.items.map((item) => item.sharedPlaceId)) });
      if (overVenue) throw conflictError(overVenue);
    }
  } else if (action === "approve") {
    // The Administrator may approve a week in the reviewer's place; he is no step (owner, 2026-10-14).
    const asAdministrator = canOverrideDecision(viewer, isTest);
    if (!asAdministrator) assertReviewer(viewer, seat, isTest);
    decidedAs = asAdministrator ? "administrator" : "reviewer";
    actorRole = asAdministrator ? "administrator" : "reviewer";
  } else {
    decidedAs = assertCanReturnPlan(viewer, seat, isTest);
    actorRole = decidedAs === "sfe" ? "sfe_manager" : decidedAs === "administrator" ? "administrator" : "reviewer";
    // A plan returned after its week could never be changed by the rep; the database refuses it too.
    if (editablePlanDays(String(planRow.week_start), today).length === 0) {
      throw conflictError("This week is over, so its plan can no longer be returned. Reload the page.");
    }
    if (!note) throw validationError("Write a note for the rep on what to change.");
    // One day alone: a working day of this week he can still change (the database refuses any other).
    if (day !== null) {
      if (!fieldWeekDays(String(planRow.week_start)).includes(day)) throw validationError("Choose a day of this week to return.");
      if (day < today) {
        throw conflictError(`${planDayLabel(day)} has passed, so it can no longer be returned on its own. Return the week, or reload the page.`);
      }
    }
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_plan_transition", {
    p: {
      plan_id: planId,
      action,
      actor_hr_id: viewer.hrId,
      actor_role: actorRole,
      is_test: isTest,
      expected_version: expectedVersion,
      note: action === "approve" || action === "return" ? note : null,
      day: action === "return" ? day : null,
    },
  });
  const status = statusOf(result.status);
  const version = Number(result.version);
  const weekStart = String(result.week_start);

  if (action === "submit") {
    // The SFE Manager who returned this week, when it was him — read off the PRE-transition row above,
    // because `submit` clears `decided_by_*`. He is told it came back; the reviewing manager gets his
    // own actionable notice as always.
    const returnedBySfeHrId =
      planRow.status === "returned" && planRow.decided_by_role === "sfe_manager" ? textOrNull(planRow.decided_by_hr_id) : null;
    await notifyPhoenixCrm(
      { kind: "plan_submitted", org: viewer.org, seat, planId, version, weekStart, submitterHrId: viewer.hrId, returnedBySfeHrId },
      isTest,
    );
  } else if (action === "approve" || action === "return") {
    // The rep who sent it and the territory's rep today (the same person unless the seat changed hands).
    const repHrIds = [...new Set([textOrNull(result.submitted_by_hr_id), seat.occupantHrId].filter((hrId): hrId is string => Boolean(hrId)))];
    await notifyPhoenixCrm(
      {
        kind: "plan_decided",
        org: viewer.org,
        seat,
        planId,
        version,
        weekStart,
        status: action === "approve" ? "approved" : "returned",
        deciderHrId: viewer.hrId,
        decidedAs,
        repHrIds,
        note,
        // The returned notice names the day when only one went back (owner, 2026-10-02) — the day the
        // DATABASE recorded, so the rep is never told "only Tuesday" of a week that went back whole.
        returnedDay: action === "return" ? textOrNull(result.returned_day) : null,
      },
      isTest,
    );
  }
  return { planId, status, version };
}

// ── The managers' review list ───────────────────────────────────────────────────────────────────

export type PlanReviewRow = {
  territory: TerritorySummary;
  plan: PlanSummary | null;
  doctors: number;
  accounts: number;
  /** Customers placed on a day they do not receive. */
  exceptions: number;
  staleItems: number;
  /** Days whose customers span more than the far-apart distance. */
  farApartDays: string[];
  canApprove: boolean;
  canReturn: boolean;
  /**
   * A rep with no Phoenix plan who filed this week in the OLD CRM (owner, 2026-10-17): the plan he filed there,
   * and whether this viewer may approve it or take that approval back. Null when Phoenix holds his week, when
   * he filed nothing in the old CRM, and in the test world.
   */
  oldCrm: OldCrmReviewPlan | null;
};

export type PlanReviewView = {
  isTest: boolean;
  weekStart: string;
  /** The plannable weeks, with the plans waiting for this viewer's decision in each. */
  weeks: Array<{ weekStart: string; waiting: number }>;
  rows: PlanReviewRow[];
  farApartKm: number;
};

const REVIEW_ORDER: Record<PhoenixCrmPlanStatus | "none", number> = { submitted: 0, returned: 1, draft: 2, none: 3, approved: 4 };

/**
 * One week's plans across the viewer's territories: waiting ones first, with their far-apart days.
 * Territories with no plan show too, so a manager sees who has not sent one. The test world lists the
 * test plans only — read for the Super Admin's "Test accounts" tab (owner, 2026-10-22), which asks for it
 * by name through `read`.
 */
export async function loadPlanReviews(
  viewer: PhoenixCrmViewer,
  raw: { test: unknown; weekStart: unknown },
  read?: TestWorldRead,
): Promise<PlanReviewView> {
  const isTest = worldFor(viewer, raw.test, read);
  const weeks = plannableWeeks(viewer.cairoToday);
  // The week he ASKED for, when he picked one. Nothing below ever overrides it.
  const requestedWeek = isFieldWeekStart(raw.weekStart) ? raw.weekStart : null;
  const weekList = requestedWeek !== null && !weeks.includes(requestedWeek) ? [requestedWeek, ...weeks] : weeks;

  const territories = testReadSeats(viewer, isTest, viewer.scopeTerritories);
  const territoryById = new Map(territories.map((seat) => [seat.seatId, seat]));
  const supabase = getSupabaseAdmin();
  const planQuery = (seatIds: string[] | null) =>
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_plans").select(PLAN_COLUMNS).eq("is_test", isTest).in("week_start", weekList);
        if (seatIds) query = query.in("seat_id", seatIds);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  let planRows: Row[];
  if ((isTest && viewer.isSuperAdmin) || viewer.basis === "all") {
    planRows = await planQuery(null);
  } else {
    // A few chunks of territories at a time, never one after another (2026-10-16 speed audit); the rows
    // keep chunk order, as the loop gave them.
    planRows = (await mapWithConcurrency(chunk([...territoryById.keys()], 100), PLAN_READ_CONCURRENCY, (part) => planQuery(part))).flat();
  }
  planRows = planRows.filter((row) => territoryById.has(String(row.seat_id)));

  // Waiting = the plans this viewer approves. The SFE Manager can return any plan but decides none of
  // them, so the page's "waiting for you" count (overview.ts) and this one stay the same number.
  const approves = (row: Row) => canReviewTerritory(viewer, territoryById.get(String(row.seat_id)) as OrgSeat, isTest);
  const waitingByWeek = new Map<string, number>();
  for (const row of planRows) {
    if (row.status !== "submitted" || !approves(row)) continue;
    const week = String(row.week_start);
    waitingByWeek.set(week, (waitingByWeek.get(week) ?? 0) + 1);
  }

  // 🔴 IT OPENS ON THE WEEK THAT IS WAITING FOR HIM (2026-10-08), not on the calendar's first week.
  // A rep plans the week starting the COMING Saturday (`repPlanWeek`), so what a manager has to decide
  // is almost never `weeks[0]` — he landed on a week with nothing on it and had to find the right one
  // from the picker, while his own notice said a plan was waiting. The earliest week with something at
  // HIS step wins; with nothing waiting anywhere it is `weeks[0]`, exactly as before. Every plan row of
  // every listed week is already loaded above, so this costs no extra read.
  const weekStart = requestedWeek ?? weeks.find((week) => (waitingByWeek.get(week) ?? 0) > 0) ?? weeks[0];

  const weekPlans = planRows.filter((row) => String(row.week_start) === weekStart);
  const planBySeat = new Map(weekPlans.map((row) => [String(row.seat_id), row]));
  const rowSeats = isTest ? weekPlans.map((row) => territoryById.get(String(row.seat_id)) as OrgSeat) : territories;

  // A rep with no Phoenix plan this week may have filed it in the old CRM (owner, 2026-10-17).
  const oldCrmCandidates = rowSeats.flatMap((seat) =>
    !planBySeat.has(seat.seatId) && personKey(seat.occupantHrId) ? [{ seatId: seat.seatId, hrId: String(seat.occupantHrId) }] : [],
  );
  const [itemRows, names, oldCrmPlans] = await Promise.all([
    loadPlanItemRows(
      weekPlans.map((row) => String(row.id)),
      REVIEW_ITEM_COLUMNS,
    ),
    loadPeopleNames([...territoryPeople(viewer.org, rowSeats), ...planPeople(weekPlans)]),
    loadOldCrmReviewPlans(viewer, oldCrmCandidates, weekStart, isTest),
  ]);
  const itemsByPlan = new Map<string, Row[]>();
  for (const row of itemRows) {
    const planId = String(row.plan_id);
    const list = itemsByPlan.get(planId) ?? [];
    list.push(row);
    itemsByPlan.set(planId, list);
  }

  const farApartKm = viewer.config.settings.farApartKm;
  const weekOpen = editablePlanDays(weekStart, viewer.cairoToday).length > 0;
  const rows = rowSeats.map((seat): PlanReviewRow => {
    const planRow = planBySeat.get(seat.seatId) ?? null;
    const items = planRow ? itemsByPlan.get(String(planRow.id)) ?? [] : [];
    const byDay = new Map<string, Array<{ id: string; lat: number; lon: number }>>();
    let doctors = 0;
    let accounts = 0;
    let exceptions = 0;
    let staleItems = 0;
    for (const item of items) {
      const itemListType = listTypeOf(item.list_type);
      if (itemListType === null) continue;
      if (itemListType === "AM") accounts += 1;
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
    const territory = describeTerritory(viewer.org, seat, names);
    const plan = planRow ? mapPlan(planRow, names, territory) : null;
    return {
      territory,
      plan,
      doctors,
      accounts,
      exceptions,
      staleItems,
      farApartDays,
      canApprove: plan?.status === "submitted" && canReviewTerritory(viewer, seat, isTest),
      canReturn: weekOpen && (plan?.status === "submitted" || plan?.status === "approved") && canReturnTerritoryPlan(viewer, seat, isTest),
      oldCrm: plan ? null : (oldCrmPlans.get(seat.seatId) ?? null),
    };
  });
  rows.sort(
    (left, right) =>
      REVIEW_ORDER[left.plan?.status ?? "none"] - REVIEW_ORDER[right.plan?.status ?? "none"] ||
      left.territory.name.localeCompare(right.territory.name),
  );

  return {
    isTest,
    weekStart,
    weeks: weekList.map((week) => ({ weekStart: week, waiting: waitingByWeek.get(week) ?? 0 })),
    rows,
    farApartKm,
  };
}

// ── What a copy copies FROM ─────────────────────────────────────────────────────────────────────

/** The longest window one copy reads: a whole month's field-weeks and a little either side. */
const COPY_SOURCE_MAX_DAYS = 45;

export type PlanCopySourceView = {
  from: string;
  to: string;
  /** Every customer placed on a day in the window, on the territory's own Phoenix plans. */
  placements: Array<{ planDate: string; customerId: string }>;
};

/**
 * The placements a "Copy last month", "Copy last week" or "Copy a day" replays (owner, 2026-09-29).
 *
 * Read from the territory's OWN Phoenix plans whatever their status — a copy is a draft the rep reviews,
 * and a week he never sent is still what he planned. Placing them is the pure plan-copy.ts on the
 * phone, and saving them is the ordinary `savePlan`, so every copied day passes the same rules a ticked
 * one does. The first month, with no Phoenix month before it, falls back to the iReports360 plan
 * (plan-history.ts).
 */
export async function loadPlanCopySource(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; from: unknown; to: unknown },
): Promise<PlanCopySourceView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  if (!isIsoDay(raw.from) || !isIsoDay(raw.to) || raw.from > raw.to) throw validationError("Choose what to copy again.");
  const from = raw.from;
  const to = raw.to;
  if (addDaysIso(from, COPY_SOURCE_MAX_DAYS) < to) throw validationError("Choose what to copy again.");

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plans")
    .select("id")
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .gte("week_start", addDaysIso(from, -6))
    .lte("week_start", to);
  throwIfError(error);
  const planIds = ((data ?? []) as Row[]).map((row) => String(row.id));
  const rows = planIds.length === 0 ? [] : await loadPlanItemRows(planIds, "id, plan_date, customer_id");
  const placements = rows
    .map((row) => ({ planDate: String(row.plan_date), customerId: String(row.customer_id) }))
    .filter((placement) => placement.planDate >= from && placement.planDate <= to)
    .sort((left, right) => left.planDate.localeCompare(right.planDate) || left.customerId.localeCompare(right.customerId));
  return { from, to, placements };
}
