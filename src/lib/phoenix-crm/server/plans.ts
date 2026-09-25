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
 *     planner data), a customer placed on a day the customer does not receive asks for a reason, and customers
 *     far apart on one day are highlighted when the plan reaches the manager;
 *   - a plan day holds at most 15 doctors and 5 accounts (settings) — the plan's only hard limit;
 *   - the district manager approves; the SFE Manager sees every plan and can return one; the system
 *     never approves a plan.
 *
 * The database function saves only the days that have not passed and checks the plan's version, so
 * two screens never overwrite each other (supabase/migrations/20260916150000_phoenix_crm.sql). Once a
 * week is over (after its Thursday, Cairo) its plan stays as it stood: it cannot be sent, reopened or
 * returned, since the rep could no longer act on a return; a late approval still records.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  editablePlanDays,
  fieldWeekDays,
  isFieldWeekStart,
  isRamadanDay,
  monthStartOf,
  planDayListTypes,
  plannableWeeks,
} from "@/lib/phoenix-crm/calendar";
import { summarizeReadiness } from "@/lib/phoenix-crm/coverage";
import { cleanText, parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { checkDaySpread } from "@/lib/phoenix-crm/geo";
import {
  describeDayWindows,
  exceptionLabel,
  isPlanEditable,
  isUuid,
  parsePlanItems,
  PLAN_DECISION_NOTE_MAX,
  planStatusLabel,
  resolvePlanItems,
  type PlanRuleCustomer,
} from "@/lib/phoenix-crm/plan-rules";
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
import { ensureReferenceCustomers, loadMonthVisitCounts, loadReadiness, loadReference, loadTerritoryCustomers, mapTimings } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

export function listTypeOf(value: unknown): PhoenixCrmListType {
  return value === "AM" ? "AM" : "PM";
}

export function statusOf(value: unknown): PhoenixCrmPlanStatus {
  return value === "submitted" || value === "approved" || value === "returned" ? value : "draft";
}

// ── Reading plans ───────────────────────────────────────────────────────────────────────────────

export const PLAN_COLUMNS =
  "id, seat_id, week_start, status, version, submitted_at, submitted_by_hr_id, decided_at, decided_by_hr_id, decided_by_role, decision_note, created_by_hr_id, updated_at, is_test";

/** Each item with its customer and place as they are now, so a customer who left the list shows. */
export const ITEM_COLUMNS =
  "id, plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note, " +
  "customer:phoenix_crm_customers!customer_id(name, grade, speciality, status), " +
  "place:phoenix_crm_places!place_id(label, brick_name, zone, lat, lon, timings, status)";

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
};

export function planPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [textOrNull(row.submitted_by_hr_id), textOrNull(row.decided_by_hr_id)]);
}

function mapPlan(row: Row, names: PeopleNames): PlanSummary {
  const status = statusOf(row.status);
  const submittedBy = textOrNull(row.submitted_by_hr_id);
  const decidedBy = textOrNull(row.decided_by_hr_id);
  return {
    planId: String(row.id),
    weekStart: String(row.week_start),
    status,
    statusLabel: planStatusLabel(status),
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

export async function loadPlanItemRows(planIds: ReadonlyArray<string>, columns: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk([...new Set(planIds)], 50)) {
    const page = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_plan_items").select(columns).in("plan_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    rows.push(...page);
  }
  return rows;
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
  listType: PhoenixCrmListType;
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
  listTypes: PhoenixCrmListType[];
  ramadan: boolean;
  /** Today or later: the rep may still change it. */
  editable: boolean;
  items: PlanItemView[];
  counts: Record<PhoenixCrmListType, number>;
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
};

export function buildDays(input: {
  weekStart: string;
  cairoToday: string;
  itemRows: ReadonlyArray<Row>;
  farApartKm: number;
  isRamadan: (isoDay: string) => boolean;
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
    const counts: Record<PhoenixCrmListType, number> = { AM: 0, PM: 0 };

    const items = rows.map((row): PlanItemView => {
      const customer = record(row.customer);
      const place = record(row.place);
      const customerId = String(row.customer_id);
      const listType = listTypeOf(row.list_type);
      counts[listType] += 1;
      const exceptionType = textOrNull(row.exception_type);
      const nearest = spread.nearestKmById[customerId];
      const pending = customer.status === "pending";
      return {
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
      };
    });
    items.sort(
      (left, right) =>
        left.listType.localeCompare(right.listType) ||
        (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
        left.name.localeCompare(right.name),
    );

    return {
      date,
      listTypes: planDayListTypes(date),
      ramadan,
      editable: date >= input.cairoToday,
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

  await ensureReferenceCustomers(seat, isTest);
  const [planRowsResult, { customers, placesByCustomer }, visitCounts, readiness] = await Promise.all([
    getSupabaseAdmin().from("phoenix_crm_plans").select(PLAN_COLUMNS).eq("seat_id", seat.seatId).eq("is_test", isTest).in("week_start", weekList),
    loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }),
    loadMonthVisitCounts(seat.seatId, isTest, monthStartOf(today), today),
    territoryReadiness(seat.seatId, isTest, false),
  ]);
  throwIfError(planRowsResult.error);
  const planRows = (planRowsResult.data ?? []) as Row[];
  const planRow = planRows.find((row) => String(row.week_start) === weekStart) ?? null;
  const [itemRows, names] = await Promise.all([
    planRow ? loadPlanItemRows([String(planRow.id)], ITEM_COLUMNS) : Promise.resolve([] as Row[]),
    loadPeopleNames([...territoryPeople(viewer.org, [seat]), ...planPeople(planRows)]),
  ]);

  const settings = viewer.config.settings;
  const isRamadan = (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides);
  const plan = planRow ? mapPlan(planRow, names) : null;
  const days = buildDays({ weekStart, cairoToday: today, itemRows, farApartKm: settings.farApartKm, isRamadan });

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
        lat: place.lat,
        lon: place.lon,
        brick: place.brickName,
        zone: place.zone,
        timings: place.timings,
      })),
    };
  });
  plannerCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  const viewerIsRep = canWriteAsRep(viewer, seat, isTest);
  const viewerIsReviewer = canReviewTerritory(viewer, seat, isTest);
  const weekOpen = weeks.includes(weekStart) && editablePlanDays(weekStart, today).length > 0;
  const status = plan?.status ?? null;
  let blockedReason: string | null = null;
  if (viewerIsRep) {
    // Owner, 2026-09-22: nothing about the list ever stops a rep planning. Only the week itself and a
    // territory with no line can, and neither is about the customers on it.
    if (!weekOpen) blockedReason = "This week has passed. Choose a week ahead to plan.";
    else if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so it cannot be planned.";
  }
  const itemCount = itemRows.length;
  const staleOnOpenDays = days.some((day) => day.editable && day.items.some((item) => item.stale));

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    cairoToday: today,
    weekStart,
    weeks: weekList.map((week) => {
      const row = planRows.find((entry) => String(entry.week_start) === week);
      const weekStatus = row ? statusOf(row.status) : null;
      return { weekStart: week, status: weekStatus, statusLabel: planStatusLabel(weekStatus) };
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
    canEdit: viewerIsRep && blockedReason === null && (status === null || isPlanEditable(status)),
    canSubmit: viewerIsRep && blockedReason === null && status !== null && isPlanEditable(status) && itemCount > 0 && !staleOnOpenDays,
    canReopen: viewerIsRep && weekOpen && (status === "submitted" || status === "approved"),
    canApprove: viewerIsReviewer && status === "submitted",
    canReturn: weekOpen && canReturnTerritoryPlan(viewer, seat, isTest) && (status === "submitted" || status === "approved"),
    blockedReason,
  };
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

export type SavedPlan = { planId: string; status: PhoenixCrmPlanStatus; version: number; itemCount: number };

function lineCodeOf(seat: OrgSeat): string {
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so it cannot be planned.");
  return seat.lineCode;
}

/**
 * Saves the days of a week that have not passed. The phone sends every item of those days; an item it
 * leaves out is taken off the plan. The days that have passed keep what was saved.
 */
export async function savePlan(viewer: PhoenixCrmViewer, raw: unknown): Promise<SavedPlan> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const today = viewer.cairoToday;
  if (!isFieldWeekStart(body.weekStart) || !plannableWeeks(today).includes(body.weekStart)) {
    throw validationError("Choose a week to plan from the list. Reload the planner.");
  }
  const weekStart = body.weekStart;
  const editableDays = editablePlanDays(weekStart, today);
  if (editableDays.length === 0) throw conflictError("This week has passed. Reload the planner.");

  // Stamps the territory ready the first time its list is complete; it then stays ready. It is a
  // progress mark for the manager's Team tab, and it has never refused a plan since 2026-09-22.
  if (!isTest) await territoryReadiness(seat.seatId, false, true);

  const drafts = parsePlanItems(body.items);
  if (!drafts.ok) throw validationError(drafts.error);
  const open = new Set(editableDays);
  if (drafts.value.some((item) => !open.has(item.planDate))) {
    throw conflictError("A day that has passed cannot be changed. Reload the planner.");
  }

  const { customers, placesByCustomer } = await loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true });
  const ruleCustomers = new Map<string, PlanRuleCustomer>(
    customers.map((row) => {
      const customerId = String(row.id);
      return [
        customerId,
        {
          customerId,
          name: String(row.name),
          listType: listTypeOf(row.list_type),
          pending: row.status === "pending",
          places: (placesByCustomer.get(customerId) ?? []).map((place) => ({ placeId: place.placeId, timings: place.timings })),
        },
      ];
    }),
  );
  const resolved = resolvePlanItems({
    weekStart,
    items: drafts.value,
    customers: ruleCustomers,
    settings: viewer.config.settings,
    isRamadan: (isoDay) => isRamadanDay(isoDay, viewer.config.ramadanOverrides),
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

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("phoenix_crm_plans").select("id, seat_id, week_start, status, is_test").eq("id", planId).maybeSingle();
  throwIfError(error);
  const planRow = data as Row | null;
  if (!planRow) throw notFoundError("This plan is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(planRow.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = planRow.is_test === true;
  const today = viewer.cairoToday;

  let actorRole: "rep" | "reviewer" | "sfe_manager";
  let decidedAs: "reviewer" | "sfe" = "reviewer";
  if (action === "submit" || action === "reopen") {
    territoryForRepWrite(viewer, seat.seatId, isTest);
    actorRole = "rep";
    if (editablePlanDays(String(planRow.week_start), today).length === 0) {
      throw conflictError("This week has passed. Reload the planner.");
    }
    if (action === "submit") {
      const openRows = (await loadPlanItemRows([planId], ITEM_COLUMNS)).filter((row) => String(row.plan_date) >= today);
      if (openRows.some(isStaleItem)) {
        throw conflictError("A planned customer left your list or changed place. Take it off the plan, save, then send.");
      }
    }
  } else if (action === "approve") {
    assertReviewer(viewer, seat, isTest);
    actorRole = "reviewer";
  } else {
    decidedAs = assertCanReturnPlan(viewer, seat, isTest);
    actorRole = decidedAs === "sfe" ? "sfe_manager" : "reviewer";
    // A plan returned after its week could never be changed by the rep; the database refuses it too.
    if (editablePlanDays(String(planRow.week_start), today).length === 0) {
      throw conflictError("This week is over, so its plan can no longer be returned. Reload the page.");
    }
    if (!note) throw validationError("Write a note for the rep on what to change.");
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
    },
  });
  const status = statusOf(result.status);
  const version = Number(result.version);
  const weekStart = String(result.week_start);

  if (action === "submit") {
    await notifyPhoenixCrm({ kind: "plan_submitted", org: viewer.org, seat, planId, version, weekStart, submitterHrId: viewer.hrId }, isTest);
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
 * Territories with no plan show too, so a manager sees who has not sent one. Test mode lists the
 * Super Admin's test plans only.
 */
export async function loadPlanReviews(viewer: PhoenixCrmViewer, raw: { test: unknown; weekStart: unknown }): Promise<PlanReviewView> {
  const isTest = readTestFlag(raw.test);
  if (isTest && !viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
  const weeks = plannableWeeks(viewer.cairoToday);
  const weekStart = isFieldWeekStart(raw.weekStart) ? raw.weekStart : weeks[0];
  const weekList = weeks.includes(weekStart) ? weeks : [weekStart, ...weeks];

  const territories = isTest ? viewer.org.territories : viewer.scopeTerritories;
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
  if (isTest || viewer.basis === "all") {
    planRows = await planQuery(null);
  } else {
    planRows = [];
    for (const part of chunk([...territoryById.keys()], 100)) planRows.push(...(await planQuery(part)));
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

  const weekPlans = planRows.filter((row) => String(row.week_start) === weekStart);
  const planBySeat = new Map(weekPlans.map((row) => [String(row.seat_id), row]));
  const rowSeats = isTest ? weekPlans.map((row) => territoryById.get(String(row.seat_id)) as OrgSeat) : territories;

  const [itemRows, names] = await Promise.all([
    loadPlanItemRows(
      weekPlans.map((row) => String(row.id)),
      REVIEW_ITEM_COLUMNS,
    ),
    loadPeopleNames([...territoryPeople(viewer.org, rowSeats), ...planPeople(weekPlans)]),
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
    const plan = planRow ? mapPlan(planRow, names) : null;
    return {
      territory: describeTerritory(viewer.org, seat, names),
      plan,
      doctors,
      accounts,
      exceptions,
      staleItems,
      farApartDays,
      canApprove: plan?.status === "submitted" && canReviewTerritory(viewer, seat, isTest),
      canReturn: weekOpen && (plan?.status === "submitted" || plan?.status === "approved") && canReturnTerritoryPlan(viewer, seat, isTest),
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
