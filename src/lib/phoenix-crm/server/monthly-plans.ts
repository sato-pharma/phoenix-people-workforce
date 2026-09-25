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
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixMonth } from "@/lib/i18n/format";
import {
  editablePlanDays,
  fieldWeeksOfMonth,
  isIsoDay,
  isMonthKey,
  isRamadanDay,
  monthEndOf,
  monthStartOf,
  plannableMonths,
} from "@/lib/phoenix-crm/calendar";
import { cleanText, parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { checkDaySpread } from "@/lib/phoenix-crm/geo";
import {
  isMonthlyPlanEditable,
  monthlyCallRate,
  monthlyPlanStatusLabel,
  summarizeMonthlyList,
  tallyDoctorMonth,
  type DoctorMonthTally,
  type MonthlyCallRate,
  type MonthlyListMeter,
} from "@/lib/phoenix-crm/monthly-plan-rules";
import { isUuid, PLAN_DECISION_NOTE_MAX, planStatusLabel } from "@/lib/phoenix-crm/plan-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  assertCanReturnPlan,
  assertReviewer,
  canReturnTerritoryPlan,
  canReviewTerritory,
  canWriteAsRep,
  readTestFlag,
  territoryForRead,
  territoryForRepWrite,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { ensureReferenceCustomers, loadMonthVisitCounts, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import {
  buildDays,
  ITEM_COLUMNS,
  isStaleItem,
  listTypeOf,
  loadPlanItemRows,
  PLAN_COLUMNS,
  planPeople,
  REVIEW_ITEM_COLUMNS,
  statusOf,
  territoryReadiness,
  type PlanDayView,
  type TerritoryReadiness,
} from "@/lib/phoenix-crm/server/plans";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

const MONTHLY_PLAN_COLUMNS =
  "id, seat_id, line_code, month_start, status, version, submitted_at, submitted_by_hr_id, decided_at, decided_by_hr_id, decided_by_role, decision_note, created_by_hr_id, updated_at, is_test";

/** The requested month, clamped to the plannable months; the first plannable month by default. */
function resolveMonth(value: unknown, plannable: string[]): string {
  if (isMonthKey(value) && plannable.includes(`${value}-01`)) return `${value}-01`;
  if (isIsoDay(value) && plannable.includes(monthStartOf(value))) return monthStartOf(value);
  return plannable[0];
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
};

function mapMonthlyPlan(row: Row, names: PeopleNames): MonthlyPlanSummary {
  const status = statusOf(row.status);
  const submittedBy = textOrNull(row.submitted_by_hr_id);
  const decidedBy = textOrNull(row.decided_by_hr_id);
  return {
    monthlyPlanId: String(row.id),
    monthStart: String(row.month_start),
    status,
    statusLabel: monthlyPlanStatusLabel(status),
    version: Number(row.version),
    submittedAt: textOrNull(row.submitted_at),
    submittedByName: submittedBy ? nameOf(names, submittedBy) : null,
    decidedAt: textOrNull(row.decided_at),
    decidedByName: decidedBy ? nameOf(names, decidedBy) : null,
    decidedBySfe: row.decided_by_role === "sfe_manager",
    decisionNote: textOrNull(row.decision_note),
    updatedAt: String(row.updated_at),
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

/** A field-week of the month, with its own status and its days (the derived weekly plan). */
export type MonthlyWeekView = {
  weekStart: string;
  status: PhoenixCrmPlanStatus | null;
  statusLabel: string;
  days: PlanDayView[];
};

export type MonthlyPlannerView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  monthStart: string;
  monthLabel: string;
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
  canEdit: boolean;
  canSubmit: boolean;
  canReopen: boolean;
  canApprove: boolean;
  canReturn: boolean;
  /** Why the rep cannot plan this month, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
};

export async function loadMonthlyPlanner(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; month: unknown },
): Promise<MonthlyPlannerView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.cairoToday;
  const months = plannableMonths(today);
  const monthStart = resolveMonth(raw.month, months);
  const weeks = fieldWeeksOfMonth(monthStart);

  await ensureReferenceCustomers(seat, isTest);
  const supabase = getSupabaseAdmin();
  const [headerResult, monthsResult, planRowsResult, { customers, placesByCustomer }, visitCounts, readiness] = await Promise.all([
    supabase.from("phoenix_crm_monthly_plans").select(MONTHLY_PLAN_COLUMNS).eq("seat_id", seat.seatId).eq("is_test", isTest).eq("month_start", monthStart).maybeSingle(),
    supabase.from("phoenix_crm_monthly_plans").select("month_start, status").eq("seat_id", seat.seatId).eq("is_test", isTest).in("month_start", months),
    weeks.length > 0
      ? supabase.from("phoenix_crm_plans").select(PLAN_COLUMNS).eq("seat_id", seat.seatId).eq("is_test", isTest).in("week_start", weeks)
      : Promise.resolve({ data: [] as Row[], error: null }),
    loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }),
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    territoryReadiness(seat.seatId, isTest, false),
  ]);
  throwIfError(headerResult.error);
  throwIfError(monthsResult.error);
  throwIfError(planRowsResult.error);
  const headerRow = headerResult.data as Row | null;
  const planRows = (planRowsResult.data ?? []) as Row[];

  const [itemRows, names] = await Promise.all([
    loadPlanItemRows(
      planRows.map((row) => String(row.id)),
      ITEM_COLUMNS,
    ),
    loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...planPeople(headerRow ? [headerRow] : [])]),
  ]);

  const settings = viewer.config.settings;
  const isRamadan = (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides);

  // Placements across the whole month, per customer and per list.
  const placementsByCustomer = new Map<string, number>();
  let amPlacements = 0;
  let pmPlacements = 0;
  for (const item of itemRows) {
    const customerId = String(item.customer_id);
    placementsByCustomer.set(customerId, (placementsByCustomer.get(customerId) ?? 0) + 1);
    if (listTypeOf(item.list_type) === "AM") amPlacements += 1;
    else pmPlacements += 1;
  }

  const plannerCustomers: PlannerCustomer[] = customers.map((row) => {
    const customerId = String(row.id);
    return {
      customerId,
      name: String(row.name),
      listType: listTypeOf(row.list_type),
      grade: parseGrade(row.grade),
      speciality: textOrNull(row.speciality),
      visitsThisMonth: visitCounts.get(customerId) ?? 0,
      pending: row.status === "pending",
      places: (placesByCustomer.get(customerId) ?? []).map((place) => ({
        placeId: place.placeId,
        label: place.label,
        address: place.address,
        lat: place.lat,
        lon: place.lon,
        brick: place.brickName,
        zone: place.zone,
        timings: place.timings,
      })),
    };
  });
  plannerCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  const tallies: MonthlyDoctorRow[] = plannerCustomers.map((customer) => {
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

  const itemsByPlan = new Map<string, Row[]>();
  for (const row of itemRows) {
    const planId = String(row.plan_id);
    const list = itemsByPlan.get(planId) ?? [];
    list.push(row);
    itemsByPlan.set(planId, list);
  }
  const weekViews: MonthlyWeekView[] = weeks.map((weekStart) => {
    const planRow = planRows.find((row) => String(row.week_start) === weekStart) ?? null;
    const weekStatus = planRow ? statusOf(planRow.status) : null;
    const weekItems = planRow ? itemsByPlan.get(String(planRow.id)) ?? [] : [];
    return {
      weekStart,
      status: weekStatus,
      statusLabel: planStatusLabel(weekStatus),
      days: buildDays({ weekStart, cairoToday: today, itemRows: weekItems, farApartKm: settings.farApartKm, isRamadan }),
    };
  });

  const monthStatusByStart = new Map<string, PhoenixCrmPlanStatus>();
  for (const row of (monthsResult.data ?? []) as Row[]) monthStatusByStart.set(String(row.month_start), statusOf(row.status));

  const plan = headerRow ? mapMonthlyPlan(headerRow, names) : null;
  const status = plan?.status ?? null;
  const viewerIsRep = canWriteAsRep(viewer, seat, isTest);
  const viewerIsReviewer = canReviewTerritory(viewer, seat, isTest);
  const monthOpen = months.includes(monthStart) && monthEndOf(monthStart) >= today;

  let blockedReason: string | null = null;
  if (viewerIsRep) {
    if (!monthOpen) blockedReason = "This month has passed. Choose a month ahead to plan.";
    else if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so it cannot be planned.";
  }
  const hasPlacements = itemRows.length > 0;
  const staleOnOpenDays = weekViews.some((week) => week.days.some((day) => day.editable && day.items.some((item) => item.stale)));

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    cairoToday: today,
    monthStart,
    monthLabel: formatPhoenixMonth(monthStart),
    months: months.map((month) => {
      const monthStatus = monthStatusByStart.get(month) ?? null;
      return { monthStart: month, label: formatPhoenixMonth(month), status: monthStatus, statusLabel: monthlyPlanStatusLabel(monthStatus) };
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
    weeks: weekViews,
    tallies,
    amMeter,
    pmMeter,
    callRate,
    customers: plannerCustomers,
    viewerIsRep,
    viewerIsReviewer,
    canEdit: viewerIsRep && blockedReason === null && isMonthlyPlanEditable(status),
    canSubmit: viewerIsRep && blockedReason === null && isMonthlyPlanEditable(status) && hasPlacements && !staleOnOpenDays,
    canReopen: viewerIsRep && monthOpen && (status === "submitted" || status === "approved"),
    canApprove: viewerIsReviewer && status === "submitted",
    canReturn: monthOpen && canReturnTerritoryPlan(viewer, seat, isTest) && (status === "submitted" || status === "approved"),
    blockedReason,
  };
}

// ── Submit / reopen (the rep) ─────────────────────────────────────────────────────────────────────

export type MonthlyTransitionResult = { monthlyPlanId: string; status: PhoenixCrmPlanStatus; version: number };

function lineCodeOf(seat: OrgSeat): string {
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so it cannot be planned.");
  return seat.lineCode;
}

/**
 * The rep sends the whole month for review, or reopens it to change it. Submit ensures the month header
 * exists (the first send creates it), then transitions; the database refuses an empty month, so the
 * rep cannot send a month with no placement in any of its weeks.
 */
export async function transitionMonthlyPlanAsRep(viewer: PhoenixCrmViewer, raw: unknown): Promise<MonthlyTransitionResult> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const action = body.action === "reopen" ? "reopen" : body.action === "submit" ? "submit" : null;
  if (!action) throw validationError("Reload the page and try again.");
  const today = viewer.cairoToday;
  const months = plannableMonths(today);
  const monthStart = resolveMonth(body.month, months);
  if (!months.includes(monthStart) || monthEndOf(monthStart) < today) {
    throw conflictError("This month has passed. Reload the planner.");
  }

  const opened = await callPhoenixCrm<Row>("phoenix_crm_open_monthly_plan", {
    p: { seat_id: seat.seatId, line_code: lineCode, month_start: monthStart, actor_hr_id: viewer.hrId, is_test: isTest },
  });
  const monthlyPlanId = String(opened.monthly_plan_id);

  const result = await callPhoenixCrm<Row>("phoenix_crm_monthly_plan_transition", {
    p: {
      monthly_plan_id: monthlyPlanId,
      action,
      actor_hr_id: viewer.hrId,
      actor_role: "rep",
      is_test: isTest,
      expected_version: Number(opened.version),
      note: null,
    },
  });
  const status = statusOf(result.status);
  const version = Number(result.version);
  if (action === "submit") {
    await notifyPhoenixCrm(
      { kind: "monthly_plan_submitted", org: viewer.org, seat, monthlyPlanId, version, monthStart: String(result.month_start), submitterHrId: viewer.hrId },
      isTest,
    );
  }
  return { monthlyPlanId, status, version };
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

  let actorRole: "reviewer" | "sfe_manager";
  let decidedAs: "reviewer" | "sfe" = "reviewer";
  if (action === "approve") {
    assertReviewer(viewer, seat, isTest);
    actorRole = "reviewer";
  } else {
    decidedAs = assertCanReturnPlan(viewer, seat, isTest);
    actorRole = decidedAs === "sfe" ? "sfe_manager" : "reviewer";
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
 * Territories with no plan show too, so a manager sees who has not sent one. Test mode lists the Super
 * Admin's test plans only.
 */
export async function loadMonthlyPlanReviews(viewer: PhoenixCrmViewer, raw: { test: unknown; month: unknown }): Promise<MonthlyReviewView> {
  const isTest = readTestFlag(raw.test);
  if (isTest && !viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
  const months = plannableMonths(viewer.cairoToday);
  const monthStart = resolveMonth(raw.month, months);

  const territories = isTest ? viewer.org.territories : viewer.scopeTerritories;
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
  let headerRows: Row[];
  if (isTest || viewer.basis === "all") {
    headerRows = await headerQuery(null);
  } else {
    headerRows = [];
    for (const part of chunk([...territoryById.keys()], 100)) headerRows.push(...(await headerQuery(part)));
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

  // The weekly plans of this month's field-weeks, for the doctor and account counts and the far-apart days.
  const weeks = fieldWeeksOfMonth(monthStart);
  const seatIds = rowSeats.map((seat) => seat.seatId);
  const planRows: Row[] = [];
  if (weeks.length > 0 && seatIds.length > 0) {
    for (const part of chunk(seatIds, 100)) {
      const page = await fetchAllRowsKeyset<Row>(
        () => supabase.from("phoenix_crm_plans").select("id, seat_id, week_start, is_test").eq("is_test", isTest).in("seat_id", part).in("week_start", weeks),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      );
      planRows.push(...page);
    }
  }
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
    const plan = headerRow ? mapMonthlyPlan(headerRow, names) : null;
    return {
      territory: describeTerritory(viewer.org, seat, names),
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
