/**
 * Phoenix CRM — the district manager's weekly plan: the board he plans on, one half-day saved at a time,
 * the send to his RSM/NSM and their decisions, and his ask to edit a week already sent. The rules, with
 * no I/O, are manager-plan-rules.ts; who may do what is manager-plan-reach.ts.
 *
 * Owner, 2026-10-16: "exactly like the numbered form that the medical reps use … instead of the doctors,
 * the medical reps appear, and the bricks they are going to today." For each half-day he picks a rep and
 * ticks that rep's own customers for it (Mark all), or Admin, or a Single visit in an area of his
 * district. The rep's customers are read from the rep's OWN plan for that day and half — a rep who has
 * not sent his week shows his draft, marked not sent; a rep with no plan is skipped.
 *
 * 🔴 THE REP NEVER SEES IT AND IS NEVER TOLD. Every notice here goes to the district manager or to the
 * person deciding his week (`ManagerPlanNotice`), never to a rep.
 *
 * 🔴 WIDENED (owner, 2026-10-17) to the regional and national sales managers and the product managers:
 * "the only difference is that he first choose the region or the district manager, then the areas of this
 * district manager appear." Their board loads ONE scope at a time — a district manager's seat, or a
 * product manager's whole line — named by the screen (`scope`), and each half-day stores the scope it was
 * planned in. Their weeks go to the manager on their HR record, then the CEO, and HR acknowledges by
 * itself (`managerApproversFor`, the transition's stamp).
 *
 * Every read and write is in ONE world: `is_test` on every query, the test world being the test accounts'.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { logWarning } from "@/lib/observability/log";
import { fieldWeekStart, isIsoDay, weeklyPlanDueOn } from "@/lib/phoenix-crm/calendar";
import {
  findManagerPlanScope,
  flagManagerCustomer,
  freeSingleVisitHalves,
  halfOfListType,
  isManagerAskLive,
  isManagerDayOpen,
  isManagerPlanStatus,
  isManagerPlanWeek,
  managerAdminActivities,
  managerAdminActivityLabel,
  managerCustomerFlagLabel,
  managerAskStage,
  managerDayHalves,
  managerPlannerTitle,
  managerPlanStage,
  managerPlanStatusLabel,
  managerPlanStatusLine,
  managerPlanWeekName,
  managerPlanWeeks,
  managerScopeKey,
  managerScopeTerritories,
  managerSlotKindLabel,
  managerSlotKinds,
  managerDmVisitTitle,
  managerSeniorTitle,
  managerSeniorVisitTitle,
  managerSlotScopeError,
  managerWeekDays,
  managerWeekState,
  MANAGER_PLAN_REASON_MAX,
  nextManagerPlanStatus,
  parseManagerSlotDraft,
  repHalfKey,
  returnStageOfApproved,
  type ManagerCustomerFlag,
  type ManagerHalf,
  type ManagerPlannerKind,
  type ManagerPlanScope,
  type ManagerPlanStage,
  type ManagerPlanStatus,
  type ManagerPlanWriter,
  type ManagerSeniorOffer,
  type ManagerSlotKind,
  type ManagerWeekState,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { planDueLabel } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canEnterMissedRecords, testModeFor, worldFor, type PhoenixCrmViewer, type TestWorldRead } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import {
  assertManagerPlanWriter,
  managerAskDeciderRole,
  managerDistrictSeats,
  managerPlace,
  managerPlanDeciderRole,
  managerPlanSeatOf,
  managerPlanWriterFor,
  notYourManagerPlanStep,
  resolveManagerPlanReader,
  seniorPlanSeatOf,
  type ManagerPlanDeciderRole,
} from "@/lib/phoenix-crm/server/manager-plan-reach";
import { assertSingleVisitPlanFits, loadLoggedSingleVisitHalves, plannedSingleVisitHalves } from "@/lib/phoenix-crm/server/manager-single-visit-cap";
import { managerApproversFor, managerWriterScopes } from "@/lib/phoenix-crm/server/manager-plan-writers";
import { loadApprovedSingleVisitDates } from "@/lib/phoenix-crm/server/manager-single-visit-day-rows";
import {
  EDIT_ASK_COLUMNS,
  editAskRowOf,
  loadEditAskRow,
  loadEditAsks,
  loadManagerPlanRow,
  loadManagerSlotCustomers,
  loadManagerSlotRows,
  loadWeekPlanRows,
  MANAGER_PLAN_COLUMNS,
  managerPlanRowOf,
  type ManagerEditAskRow,
  type ManagerPlanRow,
  type ManagerSlotCustomerRow,
  type ManagerSlotRow,
} from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadOldCrmRepWeeks, type OldCrmRep } from "@/lib/phoenix-crm/server/manager-old-crm-weeks";
import { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";
import { notifyPhoenixCrm, type ManagerPlanNotice } from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { ITEM_COLUMNS, loadPlanItemRows } from "@/lib/phoenix-crm/server/plans";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function dayOf(value: unknown): string | null {
  const text = textOrNull(value);
  return text ? text.slice(0, 10) : null;
}

export {
  EDIT_ASK_COLUMNS,
  editAskRowOf,
  loadEditAskRow,
  loadManagerPlanRow,
  loadManagerSlotCustomers,
  loadManagerSlotRows,
  MANAGER_PLAN_COLUMNS,
  managerPlanRowOf,
};
export type { ManagerEditAskRow, ManagerPlanRow, ManagerSlotCustomerRow, ManagerSlotRow };

// ── The reps' own days ──────────────────────────────────────────────────────────────────────────

/**
 * A customer of a rep's own day, as the district manager ticks him. `customerId` is null for a contact of
 * a rep's OLD-CRM plan who is not on the rep's Phoenix list: he shows, and cannot be ticked.
 */
export type RepDayCustomer = {
  customerId: string | null;
  name: string;
  grade: string | null;
  speciality: string | null;
  brickName: string | null;
  zone: string | null;
  listType: "AM" | "PM";
};

/**
 * sent — his week is with his manager or approved; not_sent — a draft or returned week; old_crm — he has no
 * Phoenix plan but filed this week in the old CRM (owner, 2026-10-17); no_plan — none at all.
 */
export type RepWeekState = "sent" | "not_sent" | "old_crm" | "no_plan";

export type RepWeek = {
  seatId: string;
  state: RepWeekState;
  /** "<seat>|<date>|<half>" → the customers of that half, in the order he planned them. */
  halves: Map<string, RepDayCustomer[]>;
  /** The old-CRM plan the halves were read from (state old_crm only): the vendor's plan id and approval status. */
  oldCrm: { crmPlanId: number; status: number | null } | null;
};

/**
 * Each rep's own week — his plan's status and his customers by day and half — for these seats.
 *
 * `oldCrmReps` names the reps (seat and HR id) whose old-CRM plan may stand in when Phoenix holds none:
 * a rep with a customer on a Phoenix plan is always read from it, and only a rep with no Phoenix plan at
 * all is read from iReports360. The real world only — the test world holds no vendor data.
 */
export async function loadRepWeeks(
  seatIds: ReadonlyArray<string>,
  weekStart: string,
  isTest: boolean,
  oldCrmReps: ReadonlyArray<OldCrmRep> = [],
): Promise<Map<string, RepWeek>> {
  const weeks = new Map<string, RepWeek>();
  for (const seatId of seatIds) weeks.set(seatId, { seatId, state: "no_plan", halves: new Map(), oldCrm: null });
  if (seatIds.length === 0) return weeks;
  // Each 100-seat part is its own read, so the parts run side by side (performance brief, 2026-10-23): a
  // national manager's week used to wait on them one after another. Concatenated in the same order.
  const planRows: Row[] = (
    await Promise.all(
      chunk(dedupeIds(seatIds), 100).map((part) =>
        fetchAllRowsKeyset<Row>(
          () =>
            getSupabaseAdmin()
              .from("phoenix_crm_plans")
              .select("id, seat_id, status")
              .in("seat_id", part)
              .eq("week_start", weekStart)
              .eq("is_test", isTest),
          { cursorColumn: "id", cursorOf: (row) => String(row.id) },
        ),
      ),
    )
  ).flat();
  const seatOfPlan = new Map<string, string>();
  for (const row of planRows) {
    const seatId = textOrNull(row.seat_id);
    const planId = textOrNull(row.id);
    if (!seatId || !planId) continue;
    seatOfPlan.set(planId, seatId);
    const week = weeks.get(seatId);
    if (week) week.state = row.status === "submitted" || row.status === "approved" ? "sent" : "not_sent";
  }
  const items = await loadPlanItemRows([...seatOfPlan.keys()], ITEM_COLUMNS);
  const counted = new Set<string>();
  for (const item of items) {
    const seatId = seatOfPlan.get(String(item.plan_id));
    const date = dayOf(item.plan_date);
    const half = halfOfListType(item.list_type);
    const customerId = textOrNull(item.customer_id);
    if (!seatId || !date || !half || !customerId || item.list_type === "Pharmacy") continue;
    const customer = record(item.customer);
    const status = textOrNull(customer.status);
    if (status !== "active" && status !== "pending") continue;
    const place = record(item.place);
    const key = repHalfKey(seatId, date, half);
    if (counted.has(`${key}|${customerId}`)) continue;
    counted.add(`${key}|${customerId}`);
    const week = weeks.get(seatId);
    if (!week) continue;
    const list = week.halves.get(key) ?? [];
    list.push({
      customerId,
      name: textOrNull(customer.name) ?? "Customer",
      grade: textOrNull(customer.grade),
      speciality: textOrNull(customer.speciality),
      brickName: textOrNull(place.brick_name),
      zone: textOrNull(place.zone),
      listType: half,
    });
    week.halves.set(key, list);
  }
  // A plan row that holds no customer at all is, to him, a rep with no plan (owner: "skipped normally").
  for (const week of weeks.values()) {
    if (week.state !== "no_plan" && week.halves.size === 0) week.state = "no_plan";
  }
  // A rep with no Phoenix plan who filed the week in the old CRM shows that plan instead (owner, 2026-10-17).
  const withoutPlan = oldCrmReps.filter((rep) => weeks.get(rep.seatId)?.state === "no_plan");
  if (withoutPlan.length > 0) {
    for (const old of (await loadOldCrmRepWeeks({ reps: withoutPlan, weekStart, isTest })).values()) {
      const week = weeks.get(old.seatId);
      if (!week || old.halves.size === 0) continue;
      week.state = "old_crm";
      week.halves = old.halves;
      week.oldCrm = { crmPlanId: old.crmPlanId, status: old.status };
    }
  }
  return weeks;
}

/** The reps among these seats who have someone in them — the ones whose old-CRM plan can stand in. */
function oldCrmRepsOf(entries: ReadonlyArray<{ seatId: string | null; hrId: string | null | undefined }>): OldCrmRep[] {
  const seen = new Map<string, OldCrmRep>();
  for (const entry of entries) {
    if (!entry.seatId || !personKey(entry.hrId)) continue;
    seen.set(entry.seatId, { seatId: entry.seatId, hrId: String(entry.hrId) });
  }
  return [...seen.values()];
}

/** The bricks of a half, in the order they first appear — where the rep is going. */
function bricksOf(customers: ReadonlyArray<RepDayCustomer>): string[] {
  const seen = new Set<string>();
  for (const customer of customers) {
    const brick = customer.brickName ?? customer.zone;
    if (brick) seen.add(brick);
  }
  return [...seen];
}

// ── The board ───────────────────────────────────────────────────────────────────────────────────

export type ManagerBoardRep = {
  seatId: string;
  hrId: string;
  name: string;
  territoryName: string;
  /** His week as a whole: sent, a draft not sent, or no plan. */
  weekState: RepWeekState;
};

/** One area to make single visits in. `vacant`: nobody holds it, and its list is the previous rep's (owner, 2026-10-19). */
export type ManagerBoardArea = { seatId: string; areaName: string; repName: string | null; vacant: boolean; territoryName: string };

export type ManagerBoardRepHalf = {
  seatId: string;
  half: ManagerHalf;
  weekState: RepWeekState;
  bricks: string[];
  customers: RepDayCustomer[];
};

export type ManagerBoardSlotCustomer = {
  customerId: string | null;
  managerCustomerId: string | null;
  name: string;
  grade: string | null;
  speciality: string | null;
  /** On Manager's own list. */
  own: boolean;
  flag: ManagerCustomerFlag | null;
  flagLabel: string | null;
};

export type ManagerBoardSlot = {
  half: ManagerHalf;
  kind: ManagerSlotKind | null;
  kindLabel: string | null;
  /** "With Ahmed Ali · 6 customers", "Training", "Single visit · Nasr City · 3 customers". */
  summary: string | null;
  repSeatId: string | null;
  repName: string | null;
  activityType: string | null;
  activityLabel: string | null;
  areaSeatId: string | null;
  areaName: string | null;
  /** With a district manager: the areas he ticked (one seat per area, as `areas` offers them). Empty otherwise. */
  areaSeatIds: string[];
  /** With a district manager: the district manager he goes with; null on a vacant district and every other kind. */
  dmName: string | null;
  /** With my manager or product manager: the person a district manager goes with, and how the picker titled them. */
  seniorHrId: string | null;
  seniorName: string | null;
  seniorTitle: string | null;
  /** With a district manager, or with my manager or product manager: each ticked area by name, a vacant one marked. */
  tickedAreas: Array<{ seatId: string; name: string; vacant: boolean }>;
  /** The scope the half-day was planned in — a regional, national or product manager's only. */
  scopeKey: string | null;
  /** "Delta (1) · Pedia — Nermeen Adel", or "Any rep in Pedia (no district manager)". */
  scopeName: string | null;
  note: string | null;
  customers: ManagerBoardSlotCustomer[];
};

/** One choice of the scope picker a regional, national or product manager plans a half-day in. */
export type ManagerBoardScope = {
  key: string;
  dmSeatId: string | null;
  lineCode: string;
  lineName: string | null;
  /** "Delta (1) · Pedia — Nermeen Adel"; a vacant district reads "no district manager". */
  name: string;
  /** The district manager on the seat; null for a vacant district and for a whole line. */
  dmName: string | null;
  /** "Delta (1) · Pedia"; null for a whole line. */
  place: string | null;
  /** The heading it sits under: the line (a product manager), the regional manager's region (an NSM), or none. */
  group: string | null;
};

export type ManagerBoardDay = {
  date: string;
  dateText: string;
  holiday: string | null;
  halves: ManagerHalf[];
  editable: boolean;
  slots: ManagerBoardSlot[];
  /** Each rep's own customers for each half of the day; a rep with nothing that half is absent. */
  repHalves: ManagerBoardRepHalf[];
};

export type ManagerBoardPlan = {
  planId: string | null;
  status: ManagerPlanStatus | null;
  statusLabel: string;
  statusLine: string;
  version: number | null;
  dueText: string;
  submittedLate: boolean | null;
  returnedDay: string | null;
  decisionNote: string | null;
  state: ManagerWeekState;
  /** His latest ask to edit this week, and how it stands. */
  editAsk: {
    requestId: string;
    status: ManagerEditAskRow["status"];
    reason: string;
    decisionNote: string | null;
    /** Who the open ask waits on now: his regional manager, then the NSM above him. */
    waitingOnName: string | null;
  } | null;
  /** Who it goes to, or went to: his RSM/NSM, then the second approver where there is one. */
  firstApproverName: string | null;
  secondApproverName: string | null;
  /** HR acknowledged the approved week by itself — a regional, national or product manager's only. */
  hrAcknowledged: boolean;
};

export type ManagerPlanBoardView = {
  isTest: boolean;
  mode: "own" | "pick";
  canWrite: boolean;
  /** The Super Admin may delete this week's plan as if it never happened (owner, 2026-10-23). */
  adminDeletes: boolean;
  weekStart: string;
  weeks: Array<{ weekStart: string; name: string }>;
  /** "pick" mode: every manager to choose from. Null in "own" mode. */
  managers: Array<{ hrId: string; name: string; place: string }> | null;
  manager: { hrId: string; name: string; place: string } | null;
  /** What the manager on the board plans as; null until one is chosen. */
  writer: { kind: ManagerPlannerKind; title: string } | null;
  /** The scopes he picks a half-day in — empty for a district manager, who plans his own district. */
  scopes: ManagerBoardScope[];
  /** The scope whose reps and areas `reps`, `areas` and each day's `repHalves` hold; null for a district manager. */
  scope: string | null;
  plan: ManagerBoardPlan | null;
  reps: ManagerBoardRep[];
  areas: ManagerBoardArea[];
  activities: Array<{ key: string; label: string }>;
  /** The half-day kinds this planner is offered — With a district manager for everyone but a district manager. */
  slotKinds: Array<{ key: ManagerSlotKind; label: string }>;
  /**
   * A district manager's With my manager or product manager picker, from the organogram above HIS seat and his
   * line's product managers (`managerSeniorOffers`). Empty for everyone else.
   */
  seniors: Array<ManagerSeniorOffer & { name: string }>;
  days: ManagerBoardDay[];
  /**
   * A district manager's single-visit half-days of his FREE day this week, counted as the save counts them —
   * his planned ones AND the halves of visits he has already logged, less those on a date his managers
   * approved. Null for every other planner.
   */
  singleVisitHalvesUsed: number | null;
  /** The dates of this week his managers approved as another day of single visits (owner, 2026-10-20). */
  singleVisitDaysApproved: string[] | null;
};

export { managerPlace };

function slotSummary(input: {
  kind: ManagerSlotKind;
  repName: string | null;
  activityLabel: string | null;
  areaName: string | null;
  scopeName: string | null;
  dmName?: string | null;
  seniorName?: string | null;
  seniorTitle?: string | null;
  count: number;
}): string {
  const customers = `${input.count} customer${input.count === 1 ? "" : "s"}`;
  const scope = input.scopeName ? ` · ${input.scopeName}` : "";
  if (input.kind === "with_rep") return `With ${input.repName ?? "a rep"} · ${customers}${scope}`;
  if (input.kind === "with_dm") return managerDmVisitTitle(input.dmName ?? null, input.areaName);
  if (input.kind === "with_senior") return managerSeniorVisitTitle(input.seniorName ?? null, input.seniorTitle ?? null, input.areaName);
  if (input.kind === "admin") return input.activityLabel ?? "Admin";
  return `Single visit · ${input.areaName ?? "an area"} · ${customers}${scope}`;
}

/**
 * 🔴 WHO A DISTRICT MANAGER MAY GO WITH (owner, 2026-10-23: "follow organogram") — the occupied manager seats
 * above his seat, nearest first (his regional manager where his line has one, then the national sales manager;
 * the national sales manager alone where there is none), then the product managers of his line: the people a
 * rep's chain visit offers (`loadDoubleVisitOffers`). Empty for everyone but a district manager on a seat.
 */
async function managerSeniorOffers(viewer: Pick<PhoenixCrmViewer, "org">, writer: ManagerPlanWriter): Promise<ManagerSeniorOffer[]> {
  if (writer.kind !== "dm" || !writer.seat) return [];
  const self = personKey(writer.hrId);
  const seen = new Set<string>(self ? [self] : []);
  const offers: ManagerSeniorOffer[] = [];
  for (const member of managerChain(viewer.org, writer.seat.seatId)) {
    const key = personKey(member.hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    offers.push({ hrId: key, role: "manager", title: managerSeniorTitle(member.seat.tier) });
  }
  // Lazily, as scope-product-managers.ts reads it: visit-asks.ts sits above this module's readers.
  const { loadLineProductManagers } = await import("@/lib/phoenix-crm/server/visit-asks");
  for (const manager of await loadLineProductManagers(writer.seat)) {
    const key = personKey(manager.hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    offers.push({ hrId: key, role: "product_manager", title: manager.role || "Product Manager" });
  }
  return offers;
}

function decidedByAdministrator(role: string | null): boolean {
  return role === "administrator";
}

function emptyView(viewer: PhoenixCrmViewer, isTest: boolean, mode: "own" | "pick", weekStart: string): ManagerPlanBoardView {
  return {
    isTest,
    mode,
    canWrite: false,
    adminDeletes: canEnterMissedRecords(viewer),
    weekStart,
    weeks: managerPlanWeeks(viewer.cairoToday).map((week) => ({ weekStart: week, name: managerPlanWeekName(week, viewer.cairoToday) })),
    managers: null,
    manager: null,
    writer: null,
    scopes: [],
    scope: null,
    plan: null,
    reps: [],
    areas: [],
    activities: managerAdminActivities("dm"),
    slotKinds: [...managerSlotKinds("dm")],
    seniors: [],
    days: [],
    singleVisitHalvesUsed: null,
    singleVisitDaysApproved: null,
  };
}

/** The scope a request names — "dm:<seat>" or "line:<code>" — if it is one of the planner's. */
function scopeFromParam(scopes: ReadonlyArray<ManagerPlanScope>, raw: unknown): ManagerPlanScope | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  return scopes.find((scope) => scope.key === text) ?? null;
}

/** "Delta (1) · Pedia — Nermeen Adel", "Cairo · Pedia — no district manager", "Any rep in Pedia (no district manager)". */
function scopeName(viewer: Pick<PhoenixCrmViewer, "org">, scope: { dmSeatId: string | null; lineCode: string | null }, names: PeopleNames): string {
  const seat = scope.dmSeatId ? viewer.org.seats.get(scope.dmSeatId) : undefined;
  if (seat) {
    const dm = personKey(seat.occupantHrId);
    return `${managerPlace(seat)} — ${dm ? nameOf(names, dm) : "no district manager"}`;
  }
  const lineName = [...viewer.org.seats.values()].find((entry) => entry.lineCode === scope.lineCode && entry.lineName)?.lineName ?? "the line";
  return `Any rep in ${lineName} (no district manager)`;
}

/** The planner's scopes as the picker shows them, grouped under the line or the regional manager's region. */
function scopeChoices(
  viewer: Pick<PhoenixCrmViewer, "org">,
  writer: ManagerPlanWriter,
  scopes: ReadonlyArray<ManagerPlanScope>,
  names: PeopleNames,
): ManagerBoardScope[] {
  return scopes.map((scope) => {
    const seat = scope.dmSeatId ? viewer.org.seats.get(scope.dmSeatId) : undefined;
    const dm = personKey(seat?.occupantHrId);
    return {
      key: scope.key,
      dmSeatId: scope.dmSeatId,
      lineCode: scope.lineCode,
      lineName: scope.lineName,
      name: scopeName(viewer, scope, names),
      dmName: dm ? nameOf(names, dm) : null,
      place: seat ? managerPlace(seat) : null,
      group: writer.kind === "pm" ? scope.lineName : scope.regionHrId ? `${nameOf(names, scope.regionHrId)}'s region` : null,
    };
  });
}

/** The board for one manager, one week and — for a regional, national or product manager — one scope. */
async function buildBoard(
  viewer: PhoenixCrmViewer,
  isTest: boolean,
  reader: { mode: "own" | "pick"; canWrite: boolean; managers: Array<{ hrId: string; kind: ManagerPlannerKind; seat: OrgSeat | null }>; managerHrId: string | null },
  weekStart: string,
  scopeParam: unknown = null,
): Promise<ManagerPlanBoardView> {
  const view = emptyView(viewer, isTest, reader.mode, weekStart);
  const pickNames = reader.mode === "pick" ? await loadPeopleNames(reader.managers.map((entry) => entry.hrId)) : new Map<string, string>();
  if (reader.mode === "pick") {
    view.managers = reader.managers
      .map((entry) => ({ hrId: entry.hrId, name: nameOf(pickNames, entry.hrId), place: managerPlace(entry.seat, entry.kind) }))
      .sort((left, right) => left.place.localeCompare(right.place) || left.name.localeCompare(right.name));
  }
  const managerHrId = reader.managerHrId;
  if (!managerHrId) return view;
  const writer = managerPlanWriterFor(viewer, managerHrId);
  if (!writer) throw notFoundError("This manager does not plan a week here now. Reload the page.");

  const scopes = await managerWriterScopes(viewer, writer);
  const chosen = scopeFromParam(scopes, scopeParam);
  const district = writer.kind === "dm" ? managerDistrictSeats(viewer, managerHrId) : chosen ? managerScopeTerritories(viewer.org, chosen, managerHrId) : [];
  const team = district.filter((entry) => Boolean(personKey(entry.occupantHrId)));
  const weekEnd = addDaysIso(weekStart, 5);

  const [holidays, planRows, seniorOffers] = await Promise.all([
    loadPlanHolidays(weekStart, weekEnd),
    loadWeekPlanRows([managerHrId], weekStart, isTest),
    managerSeniorOffers(viewer, writer),
  ]);
  const plan = planRows[0] ?? null;
  // A sent week carries its own approvers, so they are worked out (an `employees` read for everyone but a
  // district manager) only for a draft or a week not started.
  const [slots, asks, approvers] = await Promise.all([
    plan ? loadManagerSlotRows([plan.planId]) : Promise.resolve([] as ManagerSlotRow[]),
    plan ? loadEditAsks([plan.planId]) : Promise.resolve([] as ManagerEditAskRow[]),
    !plan || plan.status === "draft" ? managerApproversFor(viewer.org, writer) : Promise.resolve({ firstHrId: null, secondHrId: null }),
  ]);
  // The reps' own weeks: the chosen scope's, and every rep a saved half-day already names — so a ticked
  // customer is still flagged when the board shows another district.
  const repSeatIds = dedupeIds([...team.map((entry) => entry.seatId), ...slots.map((slot) => slot.repSeatId)]);
  const [slotCustomers, repWeeks, loggedSingleVisitHalves, approvedSingleVisitDates] = await Promise.all([
    loadManagerSlotCustomers(slots.map((slot) => slot.slotId)),
    loadRepWeeks(repSeatIds, weekStart, isTest, oldCrmRepsOf([...team.map((entry) => ({ seatId: entry.seatId, hrId: entry.occupantHrId })), ...slots.map((slot) => ({ seatId: slot.repSeatId, hrId: slot.repHrId }))])),
    writer.kind === "dm" ? loadLoggedSingleVisitHalves({ managerHrId, weekStart, isTest }) : Promise.resolve(null),
    writer.kind === "dm" ? loadApprovedSingleVisitDates({ managerHrId, weekStart, isTest }) : Promise.resolve(null),
  ]);
  const scopeSeatOccupants = [...scopes, ...slots.map((slot) => ({ dmSeatId: slot.scopeDmSeatId }))].map((scope) =>
    scope.dmSeatId ? viewer.org.seats.get(scope.dmSeatId)?.occupantHrId : null,
  );
  const names = await loadPeopleNames([
    managerHrId,
    ...team.map((entry) => entry.occupantHrId),
    ...district.map((entry) => entry.occupantHrId),
    ...scopeSeatOccupants,
    ...scopes.map((scope) => scope.regionHrId),
    approvers.firstHrId,
    approvers.secondHrId,
    plan?.firstApproverHrId,
    plan?.secondApproverHrId,
    plan?.decidedByHrId,
    plan?.firstDecidedByHrId,
    asks[0]?.approverHrId,
    asks[0]?.secondApproverHrId,
    ...slots.map((slot) => slot.repHrId),
    ...slots.map((slot) => slot.dmVisit?.dmHrId),
    ...slots.map((slot) => slot.seniorVisit?.seniorHrId),
    ...seniorOffers.map((offer) => offer.hrId),
  ]);
  view.writer = { kind: writer.kind, title: managerPlannerTitle(writer.kind) };
  view.seniors = seniorOffers.map((offer) => ({ ...offer, name: nameOf(names, offer.hrId) }));
  view.scopes = scopeChoices(viewer, writer, scopes, names);
  view.scope = chosen?.key ?? null;
  view.activities = managerAdminActivities(writer.kind);
  view.slotKinds = [...managerSlotKinds(writer.kind)];
  // The count the save refuses by: the plan's single-visit halves and the visits he has already logged, less
  // those on a date his managers approved — an approved date is paid for by its approval.
  const approvedDates = approvedSingleVisitDates ?? new Set<string>();
  view.singleVisitHalvesUsed = loggedSingleVisitHalves ? freeSingleVisitHalves(new Set([...plannedSingleVisitHalves(slots), ...loggedSingleVisitHalves]), approvedDates).size : null;
  view.singleVisitDaysApproved = approvedSingleVisitDates ? [...approvedSingleVisitDates].sort() : null;

  const latestAsk = asks[0] ?? null;
  // An ask is open at either of its two steps: with the regional manager, then with the NSM above him.
  // 🔴 ...and only on a week that is still a sent one: an ask left open on a returned week decides nothing.
  const editAsked = latestAsk ? isManagerAskLive(latestAsk.status, plan?.status ?? null) : false;
  const askWaitingOn = latestAsk && editAsked ? (latestAsk.status === "pending" ? latestAsk.approverHrId : latestAsk.status === "first_approved" ? latestAsk.secondApproverHrId : null) : null;
  const state = managerWeekState({ weekStart, cairoToday: viewer.cairoToday, status: plan?.status ?? null, editAsked });
  const canWrite = reader.mode === "own" && reader.canWrite && managerHrId === viewer.hrId;

  view.canWrite = canWrite && state === "plan";
  view.manager = { hrId: managerHrId, name: nameOf(names, managerHrId), place: managerPlace(writer.seat, writer.kind) };
  const firstApprover = plan && plan.status !== "draft" ? plan.firstApproverHrId : approvers.firstHrId;
  const secondApprover = plan && plan.status !== "draft" ? plan.secondApproverHrId : approvers.secondHrId;
  view.plan = {
    planId: plan?.planId ?? null,
    status: plan?.status ?? null,
    statusLabel: managerPlanStatusLabel(plan?.status ?? null),
    statusLine: managerPlanStatusLine({
      status: plan?.status ?? null,
      managerName: nameOf(names, managerHrId),
      firstName: firstApprover ? nameOf(names, firstApprover) : null,
      secondName: secondApprover ? nameOf(names, secondApprover) : null,
      deciderName: plan?.decidedByHrId ? nameOf(names, plan.decidedByHrId) : null,
      byAdministrator: decidedByAdministrator(plan?.decidedByRole ?? null),
      hrAcknowledged: plan?.hrAcknowledgedAt != null,
    }),
    version: plan?.version ?? null,
    dueText: planDueLabel(plan?.dueOn ?? weeklyPlanDueOn(weekStart)),
    submittedLate: plan?.submittedLate ?? null,
    returnedDay: plan?.returnedDay ?? null,
    decisionNote: plan?.status === "returned" ? plan.decisionNote : null,
    state,
    editAsk: latestAsk
      ? {
          requestId: latestAsk.requestId,
          status: latestAsk.status,
          reason: latestAsk.reason,
          decisionNote: latestAsk.decisionNote,
          waitingOnName: askWaitingOn ? nameOf(names, askWaitingOn) : null,
        }
      : null,
    firstApproverName: firstApprover ? nameOf(names, firstApprover) : null,
    secondApproverName: secondApprover ? nameOf(names, secondApprover) : null,
    hrAcknowledged: plan?.hrAcknowledgedAt != null,
  };

  view.reps = team
    .map((entry) => ({
      seatId: entry.seatId,
      hrId: entry.occupantHrId ?? "",
      name: nameOf(names, entry.occupantHrId),
      territoryName: territoryName(entry),
      weekState: repWeeks.get(entry.seatId)?.state ?? ("no_plan" as RepWeekState),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const areaSeen = new Set<string>();
  view.areas = district
    .filter((entry) => {
      const key = entry.areaCode ?? entry.areaName ?? entry.seatId;
      if (areaSeen.has(key)) return false;
      areaSeen.add(key);
      return true;
    })
    .map((entry) => ({
      seatId: entry.seatId,
      areaName: entry.areaName ?? territoryName(entry),
      repName: entry.occupantHrId ? nameOf(names, entry.occupantHrId) : null,
      vacant: !personKey(entry.occupantHrId),
      territoryName: territoryName(entry),
    }))
    .sort((left, right) => left.areaName.localeCompare(right.areaName));

  const customersBySlot = new Map<string, ManagerSlotCustomerRow[]>();
  for (const row of slotCustomers) {
    const list = customersBySlot.get(row.slotId) ?? [];
    list.push(row);
    customersBySlot.set(row.slotId, list);
  }
  const slotByKey = new Map(slots.map((slot) => [`${slot.date}|${slot.half}`, slot]));

  view.days = managerWeekDays(weekStart).map((date): ManagerBoardDay => {
    const holiday = holidays.get(date) ?? null;
    const halves = managerDayHalves(date, holiday);
    const editable = view.canWrite && isManagerDayOpen({ date, cairoToday: viewer.cairoToday, returnedDay: plan?.status === "returned" ? plan.returnedDay : null, holiday });
    const daySlots = halves.map((half): ManagerBoardSlot => {
      const slot = slotByKey.get(`${date}|${half}`) ?? null;
      if (!slot) {
        return {
          half,
          kind: null,
          kindLabel: null,
          summary: null,
          repSeatId: null,
          repName: null,
          activityType: null,
          activityLabel: null,
          areaSeatId: null,
          areaName: null,
          areaSeatIds: [],
          dmName: null,
          seniorHrId: null,
          seniorName: null,
          seniorTitle: null,
          tickedAreas: [],
          scopeKey: null,
          scopeName: null,
          note: null,
          customers: [],
        };
      }
      const repWeek = slot.repSeatId ? repWeeks.get(slot.repSeatId) : undefined;
      const onRepDay = new Set(
        (slot.repSeatId ? repWeek?.halves.get(repHalfKey(slot.repSeatId, date, half)) : undefined)?.flatMap((entry) => (entry.customerId ? [entry.customerId] : [])) ?? [],
      );
      const customers = (customersBySlot.get(slot.slotId) ?? []).map((row): ManagerBoardSlotCustomer => {
        const flag =
          slot.kind === "with_rep" && row.customerId
            ? flagManagerCustomer({ onRepDay: onRepDay.has(row.customerId), repWeekSent: repWeek?.state === "sent" || repWeek?.state === "old_crm" })
            : null;
        return {
          customerId: row.customerId,
          managerCustomerId: row.managerCustomerId,
          name: row.name,
          grade: row.grade,
          speciality: row.speciality,
          own: row.managerCustomerId !== null,
          flag,
          flagLabel: flag ? managerCustomerFlagLabel(flag) : null,
        };
      });
      const repName = slot.repHrId ? nameOf(names, slot.repHrId) : slot.repSeatId ? "No rep in this territory" : null;
      const activityLabel = managerAdminActivityLabel(slot.activityType);
      const hasScope = slot.scopeLineCode !== null;
      const slotScopeName = hasScope ? scopeName(viewer, { dmSeatId: slot.scopeDmSeatId, lineCode: slot.scopeLineCode }, names) : null;
      const dmName = slot.dmVisit?.dmHrId ? nameOf(names, slot.dmVisit.dmHrId) : null;
      const seniorHrId = slot.seniorVisit?.seniorHrId ?? null;
      const seniorName = seniorHrId ? nameOf(names, seniorHrId) : null;
      const seniorTitle = slot.seniorVisit?.title ?? null;
      return {
        half,
        kind: slot.kind,
        kindLabel: managerSlotKindLabel(slot.kind),
        summary: slotSummary({ kind: slot.kind, repName, activityLabel, areaName: slot.areaName, scopeName: slotScopeName, dmName, seniorName, seniorTitle, count: customers.length }),
        repSeatId: slot.repSeatId,
        repName,
        activityType: slot.activityType,
        activityLabel,
        areaSeatId: slot.areaSeatId,
        areaName: slot.areaName,
        areaSeatIds: (slot.dmVisit ?? slot.seniorVisit)?.areas.map((area) => area.seatId) ?? [],
        dmName,
        seniorHrId,
        seniorName,
        seniorTitle,
        // Vacant as the organogram reads now: no territory of the area has a rep on it.
        tickedAreas: ((slot.dmVisit ?? slot.seniorVisit)?.areas ?? []).map((area) => ({
          seatId: area.seatId,
          name: area.areaName,
          vacant: area.seatIds.every((seatId) => !personKey(viewer.org.seats.get(seatId)?.occupantHrId)),
        })),
        scopeKey: hasScope ? managerScopeKey(slot.scopeDmSeatId, slot.scopeLineCode ?? "") : null,
        scopeName: slotScopeName,
        note: slot.note,
        customers,
      };
    });
    const repHalves: ManagerBoardRepHalf[] = [];
    for (const half of halves) {
      for (const rep of team) {
        const week = repWeeks.get(rep.seatId);
        const customers = week?.halves.get(repHalfKey(rep.seatId, date, half)) ?? [];
        if (!week || week.state === "no_plan" || customers.length === 0) continue;
        repHalves.push({ seatId: rep.seatId, half, weekState: week.state, bricks: bricksOf(customers), customers });
      }
    }
    return { date, dateText: formatPhoenixLongDate(date), holiday, halves, editable, slots: daySlots, repHalves };
  });

  return view;
}

/**
 * GET: one week of one manager's plan — his own, or the one a reader above him picked. A regional,
 * national or product manager's board also names the scope (`scope`, "dm:<seat>" or "line:<code>") whose
 * reps and areas it carries; one he may not pick is read as none.
 */
export async function loadManagerPlanBoard(
  viewer: PhoenixCrmViewer,
  raw: { week: unknown; manager: unknown; test: unknown; scope?: unknown },
): Promise<ManagerPlanBoardView> {
  const isTest = testModeFor(viewer, raw.test);
  const reader = resolveManagerPlanReader(viewer, raw.manager);
  const asked = typeof raw.week === "string" && raw.week.trim() ? raw.week.trim() : null;
  const weeks = managerPlanWeeks(viewer.cairoToday);
  const weekStart = asked ?? weeks[weeks.length - 1];
  if (!isManagerPlanWeek(weekStart, viewer.cairoToday)) throw validationError("Choose one of the weeks shown. Reload the page.");
  return buildBoard(viewer, isTest, reader, weekStart, raw.scope ?? null);
}

/**
 * One manager's week as a READER sees it — the Approvals Hub's page. The caller has proved the viewer may
 * open it (manager-plan-hub.ts); nothing here is writable, and any week may be read, including one that
 * has passed.
 */
export async function loadManagerPlanBoardFor(viewer: PhoenixCrmViewer, managerHrId: string, weekStart: string, isTest: boolean): Promise<ManagerPlanBoardView> {
  return buildBoard(viewer, isTest, { mode: "pick", canWrite: false, managers: [], managerHrId }, weekStart);
}

/**
 * A district manager whose team has not started in Phoenix CRM keeps the legacy form (owner, 2026-10-16:
 * Mohamed Alaa until his team starts), so his week is never filed in both places; so does a regional or
 * national sales manager with no live team below him. A product manager files BOTH (owner, 2026-10-17 —
 * the no-weekly-plan deduction still reads his legacy form), so he is never refused here. A TEST- login
 * keeps its whole world, as everywhere in the module.
 */
async function assertPlansHere(viewer: PhoenixCrmViewer, writer: ManagerPlanWriter): Promise<void> {
  if (viewer.isTestPersona || writer.kind === "pm") return;
  if (await dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday })) return;
  throw forbiddenError("Your team has not started in Phoenix CRM yet, so your week is still planned on the Weekly Plan form.");
}

// ── One half-day saved ──────────────────────────────────────────────────────────────────────────

function expectedVersionOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 1 ? number : null;
}

/**
 * The rep customers a single visit names: every one must sit on a territory of the half-day's district —
 * his own, or the scope he picked for it — in his world.
 */
async function assertDistrictCustomers(
  customerIds: ReadonlyArray<string>,
  districtSeatIds: ReadonlySet<string>,
  isTest: boolean,
  outside: string,
): Promise<void> {
  if (customerIds.length === 0) return;
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, is_test").in("id", dedupeIds(customerIds)),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const found = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of customerIds) {
    const row = found.get(id);
    if (!row || row.is_test !== isTest) throw conflictError("A customer you chose is no longer on the list. Reload the page and choose again.");
    if (!districtSeatIds.has(String(row.seat_id ?? ""))) throw forbiddenError(outside);
  }
}

/**
 * With a rep, a NEW tick must sit on that rep's own half-day — the screen offers nothing else, and this is
 * the server's half of it, because a request need not come from the screen. A customer he ticked there
 * before the rep dropped him stays (owner, 2026-10-16: the row is kept and shown flagged), so the
 * customers already on this half-day with this same rep pass.
 */
async function assertOnTheRepsHalf(input: {
  managerHrId: string;
  repSeatId: string;
  /** The rep's HR id, so a rep who works in the old CRM is read from his old plan too. */
  repHrId: string | null;
  date: string;
  half: ManagerHalf;
  customerIds: ReadonlyArray<string>;
  isTest: boolean;
}): Promise<void> {
  if (input.customerIds.length === 0) return;
  const weekStart = fieldWeekStart(input.date);
  const [repWeeks, planRows] = await Promise.all([
    loadRepWeeks([input.repSeatId], weekStart, input.isTest, oldCrmRepsOf([{ seatId: input.repSeatId, hrId: input.repHrId }])),
    loadWeekPlanRows([input.managerHrId], weekStart, input.isTest),
  ]);
  const onHalf = new Set(
    (repWeeks.get(input.repSeatId)?.halves.get(repHalfKey(input.repSeatId, input.date, input.half)) ?? []).flatMap((entry) => (entry.customerId ? [entry.customerId] : [])),
  );
  const kept = new Set<string>();
  const plan = planRows[0] ?? null;
  if (plan) {
    const slot = (await loadManagerSlotRows([plan.planId])).find(
      (row) => row.date === input.date && row.half === input.half && row.kind === "with_rep" && row.repSeatId === input.repSeatId,
    );
    if (slot) {
      for (const row of await loadManagerSlotCustomers([slot.slotId])) if (row.customerId) kept.add(row.customerId);
    }
  }
  for (const id of input.customerIds) {
    if (!onHalf.has(id) && !kept.has(id)) {
      throw conflictError(`A customer you ticked is not on the rep's ${input.half} list for this day. Reload the page and tick again.`);
    }
  }
}

/**
 * POST: set, change or clear ONE half-day of his own week. The screen sends the plan version it showed;
 * the database refuses the save when another screen moved the week first. Answers with the board as it
 * now stands.
 */
export async function saveManagerPlanSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerPlanBoardView> {
  const body = record(raw);
  const writer = assertManagerPlanWriter(viewer);
  await assertPlansHere(viewer, writer);
  const isTest = testModeFor(viewer, body.test);
  const parsed = parseManagerSlotDraft(body);
  if (!parsed.ok) throw validationError(parsed.error);
  const draft = parsed.value;

  // The half-day's scope must be one of HIS (a district manager's is his own district, and Office is never his).
  const scopes = await managerWriterScopes(viewer, writer);
  const scopeError = managerSlotScopeError(writer.kind, draft, scopes);
  if (scopeError) throw validationError(scopeError);
  const scope = findManagerPlanScope(scopes, { dmSeatId: draft.scopeDmSeatId, lineCode: draft.scopeLineCode });
  const own = writer.kind === "dm";

  const holidays = await loadPlanHolidays(draft.date, draft.date);
  if (!managerDayHalves(draft.date, holidays.get(draft.date) ?? null).includes(draft.half)) {
    throw validationError(holidays.get(draft.date) ? `${holidays.get(draft.date)} is a public holiday, so it holds no plan.` : "This half-day is not a field half-day.");
  }

  // The territories this half-day may name: his own district, or the scope he picked for it.
  const district = own ? managerDistrictSeats(viewer, viewer.hrId) : scope ? managerScopeTerritories(viewer.org, scope, viewer.hrId) : [];
  let repSeat: OrgSeat | null = null;
  let areaSeat: OrgSeat | null = null;
  if (draft.kind === "with_rep") {
    repSeat = district.find((entry) => entry.seatId === draft.repSeatId && Boolean(personKey(entry.occupantHrId))) ?? null;
    if (!repSeat) throw forbiddenError(own ? "Choose one of the reps of your own team." : "Choose one of the reps of the district manager you chose.");
    await assertOnTheRepsHalf({
      managerHrId: viewer.hrId,
      repSeatId: repSeat.seatId,
      repHrId: repSeat.occupantHrId ?? null,
      date: draft.date,
      half: draft.half,
      customerIds: draft.customers.flatMap((entry) => ("customerId" in entry ? [entry.customerId] : [])),
      isTest,
    });
  }
  if (draft.kind === "single_visit") {
    areaSeat = district.find((entry) => entry.seatId === draft.areaSeatId) ?? null;
    if (!areaSeat) throw forbiddenError(own ? "Choose an area of your own district." : "Choose an area of the district manager you chose.");
    await assertDistrictCustomers(
      draft.customers.flatMap((entry) => ("customerId" in entry ? [entry.customerId] : [])),
      new Set(district.map((entry) => entry.seatId)),
      isTest,
      own ? "A single visit names customers of your own district only." : "A single visit names customers of the district you chose only.",
    );
  }

  // With a district manager (owner, 2026-10-23): the areas he ticked, each one of the chosen district manager's,
  // vacant ones included. An area is offered as ONE seat (`areas`), so every territory of that area is kept with
  // it — a chain visit on any of them answers the area.
  let dmVisit: { dm_hr_id: string | null; areas: Array<{ seat_id: string; area_code: string | null; area_name: string; seat_ids: string[] }> } | null = null;
  if (draft.kind === "with_dm") {
    const areaKey = (seat: OrgSeat) => seat.areaCode ?? seat.areaName ?? seat.seatId;
    const areas = draft.areaSeatIds.map((seatId) => {
      const seat = district.find((entry) => entry.seatId === seatId);
      if (!seat) throw forbiddenError("Choose the areas of the district manager you chose.");
      return {
        seat_id: seat.seatId,
        area_code: seat.areaCode ?? null,
        area_name: seat.areaName ?? territoryName(seat),
        seat_ids: district.filter((entry) => areaKey(entry) === areaKey(seat)).map((entry) => entry.seatId),
      };
    });
    const dmSeat = scope?.dmSeatId ? viewer.org.seats.get(scope.dmSeatId) : undefined;
    dmVisit = { dm_hr_id: personKey(dmSeat?.occupantHrId) ?? null, areas };
  }

  // With my manager or product manager (owner, 2026-10-23: "follow organogram"): one of the people offered from
  // the organogram above HIS seat and his line's product managers, and areas of his own district.
  let seniorVisit: { senior_hr_id: string; role: ManagerSeniorOffer["role"]; title: string; areas: Array<{ seat_id: string; area_code: string | null; area_name: string; seat_ids: string[] }> } | null = null;
  if (draft.kind === "with_senior") {
    const offer = (await managerSeniorOffers(viewer, writer)).find((entry) => entry.hrId === personKey(draft.seniorHrId));
    if (!offer) throw forbiddenError("Choose your own manager or a product manager of your line, as the list shows them. Reload the page.");
    const areaKey = (seat: OrgSeat) => seat.areaCode ?? seat.areaName ?? seat.seatId;
    const areas = draft.areaSeatIds.map((seatId) => {
      const seat = district.find((entry) => entry.seatId === seatId);
      if (!seat) throw forbiddenError("Choose areas of your own district.");
      return {
        seat_id: seat.seatId,
        area_code: seat.areaCode ?? null,
        area_name: seat.areaName ?? territoryName(seat),
        seat_ids: district.filter((entry) => areaKey(entry) === areaKey(seat)).map((entry) => entry.seatId),
      };
    });
    seniorVisit = { senior_hr_id: offer.hrId, role: offer.role, title: offer.title, areas };
  }
  const tickedAreas = dmVisit?.areas ?? seniorVisit?.areas ?? null;

  // A district manager's single visits are one day a week at most — two half-days (owner, 2026-10-19).
  if (draft.kind === "single_visit" && own) {
    await assertSingleVisitPlanFits({ managerHrId: viewer.hrId, weekStart: fieldWeekStart(draft.date), date: draft.date, half: draft.half, isTest });
  }

  const saved = record(await callPhoenixCrm<Row>("phoenix_crm_save_manager_plan_slot", {
    p: {
      manager_hr_id: viewer.hrId,
      manager_seat_id: writer.seat?.seatId ?? null,
      planner_kind: writer.kind,
      line_code: writer.kind === "pm" ? null : (writer.seat?.lineCode ?? null),
      actor_hr_id: viewer.hrId,
      plan_date: draft.date,
      half: draft.half,
      kind: draft.kind,
      rep_seat_id: repSeat?.seatId ?? null,
      rep_hr_id: repSeat?.occupantHrId ?? null,
      activity_type: draft.activityType,
      area_seat_id: areaSeat?.seatId ?? null,
      area_code: areaSeat ? (areaSeat.areaCode ?? areaSeat.seatId) : null,
      area_name: areaSeat ? (areaSeat.areaName ?? territoryName(areaSeat)) : tickedAreas ? tickedAreas.map((area) => area.area_name).join(", ") : null,
      dm_visit: dmVisit,
      senior_visit: seniorVisit,
      scope_dm_seat_id: own ? null : (scope?.dmSeatId ?? null),
      scope_line_code: own ? null : (scope?.lineCode ?? null),
      note: draft.note,
      customers: draft.customers.map((entry) => ("customerId" in entry ? { customer_id: entry.customerId } : { manager_customer_id: entry.managerCustomerId })),
      expected_version: expectedVersionOf(body.expectedVersion),
      is_test: isTest,
    },
  }));

  const savedSlotId = textOrNull(saved.slot_id);
  if (draft.kind === "single_visit" && savedSlotId) {
    await relinkPlannedVisits({ managerHrId: viewer.hrId, date: draft.date, half: draft.half, slotId: savedSlotId, isTest });
  }

  // The board answers in the scope the screen is showing (it sends it, since a waiting half-day of another
  // day may be the one saved), or else the one this half-day was planned in — so the screen stays where he was.
  return buildBoard(viewer, isTest, resolveManagerPlanReader(viewer, viewer.hrId), fieldWeekStart(draft.date), textOrNull(body.scope) ?? scope?.key ?? null);
}

/**
 * The save writes a half-day afresh — the old slot row is deleted and a new one inserted — so every visit
 * he had already logged against it is left with `plan_slot_id` null by the foreign key (`on delete set
 * null`) while still marked planned. Re-saving a single-visit half-day he has already started (a week
 * returned for that day, or the running week) therefore hands those visits to the new slot. Only PLANNED
 * visits of that same day and half move; an unplanned one stays unplanned. The actual-versus-planned report
 * matches by day and customer and never read the link, so a failure here is logged, never thrown: the
 * half-day itself is already saved.
 */
async function relinkPlannedVisits(input: { managerHrId: string; date: string; half: ManagerHalf; slotId: string; isTest: boolean }): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_visits")
    .update({ plan_slot_id: input.slotId })
    .eq("manager_hr_id", input.managerHrId)
    .eq("visit_date", input.date)
    .eq("half", input.half)
    .eq("is_unplanned", false)
    .is("plan_slot_id", null)
    .eq("is_test", input.isTest);
  if (error) {
    logWarning("Phoenix CRM could not re-link a district manager's visits to the re-saved half-day", {
      labels: { event: "phoenix_crm_manager_visit_relink_failed" },
      error,
      context: { managerHrId: input.managerHrId, date: input.date, half: input.half },
    });
  }
}

// ── Send, approve, return ───────────────────────────────────────────────────────────────────────

export type ManagerPlanTransitionResult = {
  planId: string;
  status: ManagerPlanStatus;
  version: number;
  weekStart: string;
};

function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > MANAGER_PLAN_REASON_MAX) throw validationError(`Keep the note under ${MANAGER_PLAN_REASON_MAX} characters.`);
  return text.length > 0 ? text : null;
}

/**
 * The seat a notice about this plan is filed on: the seat the plan was filed on, or his seat now. A
 * product manager's week has none — he sits on no seat — and its notices go out without one.
 */
function noticeSeat(viewer: Pick<PhoenixCrmViewer, "org">, plan: Pick<ManagerPlanRow, "managerSeatId" | "managerHrId" | "plannerKind">): OrgSeat | null {
  if (plan.plannerKind === "pm") return null;
  const filed = plan.managerSeatId ? viewer.org.seats.get(plan.managerSeatId) : undefined;
  if (filed) return filed;
  return plan.plannerKind === "dm" ? managerPlanSeatOf(viewer, plan.managerHrId) : seniorPlanSeatOf(viewer, plan.managerHrId);
}

async function tellManagerPlan(viewer: Pick<PhoenixCrmViewer, "org">, plan: ManagerPlanRow, notice: Omit<ManagerPlanNotice, "kind" | "seat" | "managerHrId" | "weekStart" | "planId" | "plannerKind">, isTest: boolean): Promise<void> {
  const seat = noticeSeat(viewer, plan);
  if (!seat && plan.plannerKind !== "pm") return;
  await notifyPhoenixCrm(
    { kind: "manager_plan", seat, plannerKind: plan.plannerKind, managerHrId: plan.managerHrId, weekStart: plan.weekStart, planId: plan.planId, ...notice },
    isTest,
  );
}

/**
 * POST: send his week (submit), or decide it (approve, return — the week or ONE day). The send is his
 * alone; a decision belongs to the approver stored on the row for its stage, or the Administrator in his
 * place. The approvers are read from the organogram at the send and stored on the row, so a week already
 * sent keeps going to the people it was sent to.
 */
export async function transitionManagerPlan(
  viewer: PhoenixCrmViewer,
  raw: unknown,
  read?: TestWorldRead,
): Promise<ManagerPlanTransitionResult> {
  const body = record(raw);
  const action = body.action;
  if (action !== "submit" && action !== "approve" && action !== "return") throw validationError("Choose Send, Approve or Return.");
  const planId = textOrNull(body.planId);
  if (!planId) throw validationError("This plan could not be read. Reload the page.");
  // The Super Admin's "Test accounts" tab asks for the test world by name (owner, 2026-10-22).
  const isTest = worldFor(viewer, body.test, read);
  const plan = await loadManagerPlanRow(planId, isTest);
  if (!plan) throw notFoundError("This plan is no longer there. Reload the page.");
  const note = noteOf(body.note);
  // Every send and decision names the version its screen showed, so a page left open on an older week
  // is refused rather than deciding the week as it stands now.
  const expectedVersion = expectedVersionOf(body.version);
  if (expectedVersion === null) throw validationError("This plan could not be read. Reload the page.");

  if (action === "submit") {
    const writer = assertManagerPlanWriter(viewer);
    await assertPlansHere(viewer, writer);
    if (plan.managerHrId !== viewer.hrId) throw forbiddenError("Only the manager who owns this week can send it.");
    const approvers = await managerApproversFor(viewer.org, writer);
    const result = record(
      await callPhoenixCrm<Row>("phoenix_crm_manager_plan_transition", {
        p: {
          plan_id: plan.planId,
          action: "submit",
          actor_hr_id: viewer.hrId,
          actor_role: "manager",
          first_approver_hr_id: approvers.firstHrId,
          second_approver_hr_id: approvers.secondHrId,
          expected_version: expectedVersion,
          is_test: isTest,
        },
      }),
    );
    if (approvers.firstHrId) {
      await tellManagerPlan(
        viewer,
        plan,
        {
          step: "waiting",
          recipientHrId: approvers.firstHrId,
          actorHrId: viewer.hrId,
          recordId: plan.planId,
          version: Number(result.version ?? plan.version),
          note: null,
          customerName: null,
          byAdministrator: false,
          late: result.submitted_late === true,
        },
        isTest,
      );
    }
    return { planId: plan.planId, status: isManagerPlanStatus(result.status) ? result.status : "submitted", version: Number(result.version ?? plan.version), weekStart: plan.weekStart };
  }

  // A decision. The stage is the row's own: whose turn it is now, or — to return a week already
  // approved — the last approver's.
  const hasSecond = plan.secondApproverHrId !== null;
  const stage: ManagerPlanStage | null =
    action === "return" && plan.status === "approved" ? returnStageOfApproved(hasSecond) : managerPlanStage(plan.status);
  if (!stage || nextManagerPlanStatus({ action, status: plan.status, stage, hasSecond }) === null) {
    throw conflictError("This week has already moved on. Reload the page.");
  }
  const role: ManagerPlanDeciderRole | null = managerPlanDeciderRole(viewer, {
    stage,
    firstApproverHrId: plan.firstApproverHrId,
    secondApproverHrId: plan.secondApproverHrId,
    isTest,
  });
  if (!role) throw notYourManagerPlanStep(plan.status);
  const day = textOrNull(body.day);
  if (day !== null && (action !== "return" || !isIsoDay(day))) throw validationError("Choose a day of the week to return.");
  if (action === "return" && !note) throw validationError("Write what should change, so the manager knows.");

  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_manager_plan_transition", {
      p: {
        plan_id: plan.planId,
        action,
        actor_hr_id: viewer.hrId,
        actor_role: role,
        stage,
        note,
        day,
        expected_version: expectedVersion,
        is_test: isTest,
      },
    }),
  );
  const status: ManagerPlanStatus = isManagerPlanStatus(result.status) ? result.status : plan.status;
  const version = Number(result.version ?? plan.version);
  const byAdministrator = role === "administrator";

  if (status === "first_approved" && plan.secondApproverHrId) {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "waiting", recipientHrId: plan.secondApproverHrId, actorHrId: viewer.hrId, recordId: plan.planId, version, note: null, customerName: null, byAdministrator, late: plan.submittedLate === true },
      isTest,
    );
  } else if (status === "approved") {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "approved", recipientHrId: plan.managerHrId, actorHrId: viewer.hrId, recordId: plan.planId, version, note, customerName: null, byAdministrator },
      isTest,
    );
  } else if (status === "returned") {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "returned", recipientHrId: plan.managerHrId, actorHrId: viewer.hrId, recordId: plan.planId, version, note, customerName: null, byAdministrator, returnedDay: day },
      isTest,
    );
  }
  return { planId: plan.planId, status, version, weekStart: plan.weekStart };
}

// ── His ask to edit a week already sent ─────────────────────────────────────────────────────────

/**
 * POST: he asks to edit a week he sent (owner, 2026-10-16: a rep who sends AFTER him is caught this way,
 * and his RSM/NSM approves the reopening). 🔴 After a regional manager agrees, the national sales manager
 * above him approves the reopening too (owner, 2026-10-17, "Week + edit asks + removals") — the second
 * approver is stored on the ask, as on the week, and the week sent again goes RSM → NSM as before.
 */
export async function raiseManagerPlanEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; planId: string }> {
  const body = record(raw);
  const writer = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, body.test);
  const planId = textOrNull(body.planId);
  if (!planId) throw validationError("This plan could not be read. Reload the page.");
  const plan = await loadManagerPlanRow(planId, isTest);
  if (!plan || plan.managerHrId !== viewer.hrId) throw notFoundError("This plan is no longer there. Reload the page.");
  const reason = noteOf(body.reason);
  if (!reason || reason.length < 3) throw validationError("Write why you need to change the week.");
  const approvers = await managerApproversFor(viewer.org, writer);
  const approverHrId = approvers.firstHrId;
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_raise_manager_plan_edit", {
      p: {
        plan_id: plan.planId,
        actor_hr_id: viewer.hrId,
        approver_hr_id: approverHrId,
        second_approver_hr_id: approvers.secondHrId,
        reason,
        is_test: isTest,
      },
    }),
  );
  const requestId = String(result.request_id ?? "");
  if (approverHrId && requestId) {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "edit_waiting", recipientHrId: approverHrId, actorHrId: viewer.hrId, recordId: requestId, version: 1, note: reason, customerName: null, byAdministrator: false },
      isTest,
    );
  }
  return { requestId, planId: plan.planId };
}

/**
 * POST: the holder of the ask's step — his regional manager first, then the national sales manager stored
 * on the ask — or the Administrator in place of either, reopens the week (or passes it on) or refuses the
 * ask. The step is the ask's own status, and the page names the step it showed, so a page left open on a
 * step already decided is refused rather than deciding the next one unread.
 */
export async function decideManagerPlanEdit(
  viewer: PhoenixCrmViewer,
  raw: unknown,
  read?: TestWorldRead,
): Promise<{ requestId: string; status: string; planStatus: string }> {
  const body = record(raw);
  const decision = body.decision;
  if (decision !== "reopen" && decision !== "refuse") throw validationError("Choose Reopen or Refuse.");
  const requestId = textOrNull(body.requestId);
  if (!requestId) throw validationError("This ask could not be read. Reload the page.");
  const isTest = worldFor(viewer, body.test, read);
  const ask = await loadEditAskRow(requestId);
  if (!ask || ask.isTest !== isTest) throw notFoundError("This ask to edit is no longer there. Reload the page.");
  const stage = managerAskStage(ask.status);
  if (!stage || (body.stage !== undefined && body.stage !== stage)) throw conflictError("This ask has already moved on. Reload the page.");
  const role = managerAskDeciderRole(viewer, { stage, approverHrId: ask.approverHrId, secondApproverHrId: ask.secondApproverHrId, isTest });
  if (!role) {
    throw forbiddenError(
      stage === "second"
        ? "This ask is waiting for its second approver, who decides this step."
        : "This ask is decided by the manager it was sent to.",
    );
  }
  const note = noteOf(body.note);
  if (decision === "refuse" && !note) throw validationError("Write why the week stays as it was sent.");
  const expectedVersion = expectedVersionOf(body.version);
  if (expectedVersion === null) throw validationError("This ask could not be read. Reload the page.");
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_decide_manager_plan_edit", {
      p: {
        request_id: requestId,
        decision,
        actor_hr_id: viewer.hrId,
        actor_role: role,
        stage,
        note,
        expected_version: expectedVersion,
        is_test: isTest,
      },
    }),
  );
  const plan = await loadManagerPlanRow(ask.planId, isTest);
  if (plan && result.status === "first_approved" && ask.secondApproverHrId) {
    // The regional manager agreed: the national sales manager decides next. The district manager is told
    // nothing yet — his own requests list says who it waits on.
    await tellManagerPlan(
      viewer,
      plan,
      {
        step: "edit_waiting",
        recipientHrId: ask.secondApproverHrId,
        actorHrId: viewer.hrId,
        recordId: requestId,
        version: ask.version + 1,
        note: ask.reason,
        customerName: null,
        byAdministrator: role === "administrator",
        secondStep: true,
      },
      isTest,
    );
  } else if (plan) {
    await tellManagerPlan(
      viewer,
      plan,
      {
        step: decision === "reopen" ? "edit_reopened" : "edit_refused",
        recipientHrId: ask.managerHrId,
        actorHrId: viewer.hrId,
        recordId: requestId,
        version: ask.version + 1,
        note,
        customerName: null,
        byAdministrator: role === "administrator",
      },
      isTest,
    );
  }
  return { requestId, status: String(result.status ?? ""), planStatus: String(result.plan_status ?? "") };
}

/**
 * The daily pass: an ask to edit nobody answered before its week ended is closed, and the district
 * manager is told — in-app and by Telegram, never the phone, never email (the rep's expiry's rule). The
 * rows are chosen in SQL, against the database's own Cairo day. Never throws for a single notice.
 */
export async function runManagerPlanEditExpiry(): Promise<{ expired: number; told: number }> {
  const result = record(await callPhoenixCrm<Row>("phoenix_crm_expire_manager_plan_edit_requests", { p: {} }));
  const expired = Array.isArray(result.expired) ? result.expired.map(record) : [];
  if (expired.length === 0) return { expired: 0, told: 0 };
  logWarning("Phoenix CRM closed district-manager asks to edit a week that had passed", {
    labels: { event: "phoenix_crm_manager_plan_edit_expired", count: String(expired.length) },
  });
  const org = await loadPhoenixCrmOrg();
  let told = 0;
  for (const row of expired) {
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    const requestId = textOrNull(row.request_id);
    const planId = textOrNull(row.plan_id);
    const isTest = row.is_test === true;
    if (!managerHrId || !requestId || !planId) continue;
    const plan = await loadManagerPlanRow(planId, isTest);
    if (!plan) continue;
    await tellManagerPlan(
      { org },
      plan,
      { step: "edit_expired", recipientHrId: managerHrId, actorHrId: null, recordId: requestId, version: 0, note: null, customerName: null, byAdministrator: false },
      isTest,
    );
    told += 1;
  }
  return { expired: expired.length, told };
}
