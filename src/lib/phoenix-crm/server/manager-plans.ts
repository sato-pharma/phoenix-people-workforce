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
 * Every read and write is in ONE world: `is_test` on every query, the test world being the test accounts'.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { logWarning } from "@/lib/observability/log";
import { fieldWeekStart, isIsoDay, weeklyPlanDueOn } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, isDayActivity, PHOENIX_CRM_DAY_ACTIVITIES } from "@/lib/phoenix-crm/day-activities";
import {
  flagManagerCustomer,
  halfOfListType,
  isManagerDayOpen,
  isManagerPlanStatus,
  isManagerPlanWeek,
  managerCustomerFlagLabel,
  managerDayHalves,
  managerPlanApprovers,
  managerPlanStage,
  managerPlanStatusLabel,
  managerPlanStatusLine,
  managerPlanWeekName,
  managerPlanWeeks,
  managerSlotKindLabel,
  managerWeekDays,
  managerWeekState,
  MANAGER_PLAN_REASON_MAX,
  nextManagerPlanStatus,
  parseManagerSlotDraft,
  repHalfKey,
  returnStageOfApproved,
  type ManagerCustomerFlag,
  type ManagerHalf,
  type ManagerPlanStage,
  type ManagerPlanStatus,
  type ManagerSlotKind,
  type ManagerWeekState,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { planDueLabel } from "@/lib/phoenix-crm/plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import {
  assertManagerPlanWriter,
  managerAskDeciderRole,
  managerDistrictSeats,
  managerPlace,
  managerPlanDeciderRole,
  managerPlanSeatOf,
  managerTeamSeats,
  notYourManagerPlanStep,
  resolveManagerPlanReader,
  type ManagerPlanDeciderRole,
} from "@/lib/phoenix-crm/server/manager-plan-reach";
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
import { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";
import { notifyPhoenixCrm, type ManagerPlanNotice } from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
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

/** A customer of a rep's own day, as the district manager ticks him. */
export type RepDayCustomer = {
  customerId: string;
  name: string;
  grade: string | null;
  speciality: string | null;
  brickName: string | null;
  zone: string | null;
  listType: "AM" | "PM";
};

/** sent — his week is with his manager or approved; not_sent — a draft or returned week; no_plan — none at all. */
export type RepWeekState = "sent" | "not_sent" | "no_plan";

export type RepWeek = {
  seatId: string;
  state: RepWeekState;
  /** "<seat>|<date>|<half>" → the customers of that half, in the order he planned them. */
  halves: Map<string, RepDayCustomer[]>;
};

/** Each rep's own week — his plan's status and his customers by day and half — for these seats. */
export async function loadRepWeeks(seatIds: ReadonlyArray<string>, weekStart: string, isTest: boolean): Promise<Map<string, RepWeek>> {
  const weeks = new Map<string, RepWeek>();
  for (const seatId of seatIds) weeks.set(seatId, { seatId, state: "no_plan", halves: new Map() });
  if (seatIds.length === 0) return weeks;
  const planRows: Row[] = [];
  for (const part of chunk(dedupeIds(seatIds), 100)) {
    planRows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_plans")
            .select("id, seat_id, status")
            .in("seat_id", part)
            .eq("week_start", weekStart)
            .eq("is_test", isTest),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
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
  return weeks;
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

export type ManagerBoardArea = { seatId: string; areaName: string; repName: string | null; territoryName: string };

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
  note: string | null;
  customers: ManagerBoardSlotCustomer[];
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
  editAsk: { requestId: string; status: ManagerEditAskRow["status"]; reason: string; decisionNote: string | null } | null;
  /** Who it goes to, or went to: his RSM/NSM, then the second approver where there is one. */
  firstApproverName: string | null;
  secondApproverName: string | null;
};

export type ManagerPlanBoardView = {
  isTest: boolean;
  mode: "own" | "pick";
  canWrite: boolean;
  weekStart: string;
  weeks: Array<{ weekStart: string; name: string }>;
  /** "pick" mode: every district manager to choose from. Null in "own" mode. */
  managers: Array<{ hrId: string; name: string; place: string }> | null;
  manager: { hrId: string; name: string; place: string } | null;
  plan: ManagerBoardPlan | null;
  reps: ManagerBoardRep[];
  areas: ManagerBoardArea[];
  activities: Array<{ key: string; label: string }>;
  days: ManagerBoardDay[];
};

export { managerPlace };

function slotSummary(input: { kind: ManagerSlotKind; repName: string | null; activityLabel: string | null; areaName: string | null; count: number }): string {
  const customers = `${input.count} customer${input.count === 1 ? "" : "s"}`;
  if (input.kind === "with_rep") return `With ${input.repName ?? "a rep"} · ${customers}`;
  if (input.kind === "admin") return input.activityLabel ?? "Admin";
  return `Single visit · ${input.areaName ?? "an area"} · ${customers}`;
}

function decidedByAdministrator(role: string | null): boolean {
  return role === "administrator";
}

function emptyView(viewer: PhoenixCrmViewer, isTest: boolean, mode: "own" | "pick", weekStart: string): ManagerPlanBoardView {
  return {
    isTest,
    mode,
    canWrite: false,
    weekStart,
    weeks: managerPlanWeeks(viewer.cairoToday).map((week) => ({ weekStart: week, name: managerPlanWeekName(week, viewer.cairoToday) })),
    managers: null,
    manager: null,
    plan: null,
    reps: [],
    areas: [],
    activities: PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => ({ key: entry.key, label: entry.label })),
    days: [],
  };
}

/** The board for one district manager and one week. */
async function buildBoard(
  viewer: PhoenixCrmViewer,
  isTest: boolean,
  reader: { mode: "own" | "pick"; canWrite: boolean; managers: Array<{ hrId: string; seat: OrgSeat }>; managerHrId: string | null },
  weekStart: string,
): Promise<ManagerPlanBoardView> {
  const view = emptyView(viewer, isTest, reader.mode, weekStart);
  const pickNames = reader.mode === "pick" ? await loadPeopleNames(reader.managers.map((entry) => entry.hrId)) : new Map<string, string>();
  if (reader.mode === "pick") {
    view.managers = reader.managers
      .map((entry) => ({ hrId: entry.hrId, name: nameOf(pickNames, entry.hrId), place: managerPlace(entry.seat) }))
      .sort((left, right) => left.place.localeCompare(right.place) || left.name.localeCompare(right.name));
  }
  const managerHrId = reader.managerHrId;
  if (!managerHrId) return view;
  const seat = managerPlanSeatOf(viewer, managerHrId);
  if (!seat) throw notFoundError("This district manager holds no district seat now. Reload the page.");

  const team = managerTeamSeats(viewer, managerHrId);
  const district = managerDistrictSeats(viewer, managerHrId);
  const approvers = managerPlanApprovers(viewer.org, seat.seatId);
  const weekEnd = addDaysIso(weekStart, 5);

  const [holidays, planRows, repWeeks] = await Promise.all([
    loadPlanHolidays(weekStart, weekEnd),
    loadWeekPlanRows([managerHrId], weekStart, isTest),
    loadRepWeeks(team.map((entry) => entry.seatId), weekStart, isTest),
  ]);
  const plan = planRows[0] ?? null;
  const [slots, asks] = await Promise.all([
    plan ? loadManagerSlotRows([plan.planId]) : Promise.resolve([] as ManagerSlotRow[]),
    plan ? loadEditAsks([plan.planId]) : Promise.resolve([] as ManagerEditAskRow[]),
  ]);
  const slotCustomers = await loadManagerSlotCustomers(slots.map((slot) => slot.slotId));
  const names = await loadPeopleNames([
    managerHrId,
    ...team.map((entry) => entry.occupantHrId),
    ...district.map((entry) => entry.occupantHrId),
    approvers.first?.hrId,
    approvers.secondHrId,
    plan?.firstApproverHrId,
    plan?.secondApproverHrId,
    plan?.decidedByHrId,
    plan?.firstDecidedByHrId,
    ...slots.map((slot) => slot.repHrId),
  ]);

  const latestAsk = asks[0] ?? null;
  const editAsked = latestAsk?.status === "pending";
  const state = managerWeekState({ weekStart, cairoToday: viewer.cairoToday, status: plan?.status ?? null, editAsked });
  const canWrite = reader.mode === "own" && reader.canWrite && managerHrId === viewer.hrId;

  view.canWrite = canWrite && state === "plan";
  view.manager = { hrId: managerHrId, name: nameOf(names, managerHrId), place: managerPlace(seat) };
  const firstApprover = plan && plan.status !== "draft" ? plan.firstApproverHrId : (approvers.first?.hrId ?? null);
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
    }),
    version: plan?.version ?? null,
    dueText: planDueLabel(plan?.dueOn ?? weeklyPlanDueOn(weekStart)),
    submittedLate: plan?.submittedLate ?? null,
    returnedDay: plan?.returnedDay ?? null,
    decisionNote: plan?.status === "returned" ? plan.decisionNote : null,
    state,
    editAsk: latestAsk ? { requestId: latestAsk.requestId, status: latestAsk.status, reason: latestAsk.reason, decisionNote: latestAsk.decisionNote } : null,
    firstApproverName: firstApprover ? nameOf(names, firstApprover) : null,
    secondApproverName: secondApprover ? nameOf(names, secondApprover) : null,
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
          note: null,
          customers: [],
        };
      }
      const repWeek = slot.repSeatId ? repWeeks.get(slot.repSeatId) : undefined;
      const onRepDay = new Set((slot.repSeatId ? repWeek?.halves.get(repHalfKey(slot.repSeatId, date, half)) : undefined)?.map((entry) => entry.customerId) ?? []);
      const customers = (customersBySlot.get(slot.slotId) ?? []).map((row): ManagerBoardSlotCustomer => {
        const flag =
          slot.kind === "with_rep" && row.customerId
            ? flagManagerCustomer({ onRepDay: onRepDay.has(row.customerId), repWeekSent: repWeek?.state === "sent" })
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
      const activityLabel = isDayActivity(slot.activityType) ? dayActivityLabel(slot.activityType) : null;
      return {
        half,
        kind: slot.kind,
        kindLabel: managerSlotKindLabel(slot.kind),
        summary: slotSummary({ kind: slot.kind, repName, activityLabel, areaName: slot.areaName, count: customers.length }),
        repSeatId: slot.repSeatId,
        repName,
        activityType: slot.activityType,
        activityLabel,
        areaSeatId: slot.areaSeatId,
        areaName: slot.areaName,
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

/** GET: one week of one district manager's plan — his own, or the one a reader above him picked. */
export async function loadManagerPlanBoard(
  viewer: PhoenixCrmViewer,
  raw: { week: unknown; manager: unknown; test: unknown },
): Promise<ManagerPlanBoardView> {
  const isTest = testModeFor(viewer, raw.test);
  const reader = resolveManagerPlanReader(viewer, raw.manager);
  const asked = typeof raw.week === "string" && raw.week.trim() ? raw.week.trim() : null;
  const weeks = managerPlanWeeks(viewer.cairoToday);
  const weekStart = asked ?? weeks[weeks.length - 1];
  if (!isManagerPlanWeek(weekStart, viewer.cairoToday)) throw validationError("Choose one of the weeks shown. Reload the page.");
  return buildBoard(viewer, isTest, reader, weekStart);
}

/**
 * One district manager's week as a READER sees it — the Approvals Hub's page. The caller has proved the
 * viewer may open it (manager-plan-hub.ts); nothing here is writable, and any week may be read, including
 * one that has passed.
 */
export async function loadManagerPlanBoardFor(viewer: PhoenixCrmViewer, managerHrId: string, weekStart: string, isTest: boolean): Promise<ManagerPlanBoardView> {
  return buildBoard(viewer, isTest, { mode: "pick", canWrite: false, managers: [], managerHrId }, weekStart);
}

/**
 * A district manager whose team has not started in Phoenix CRM keeps the legacy form (owner, 2026-10-16:
 * Mohamed Alaa until his team starts), so his week is never filed in both places. A TEST- login keeps
 * its whole world, as everywhere in the module.
 */
async function assertPlansHere(viewer: PhoenixCrmViewer): Promise<void> {
  if (viewer.isTestPersona) return;
  if (await dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday })) return;
  throw forbiddenError("Your team has not started in Phoenix CRM yet, so your week is still planned on the Weekly Plan form.");
}

// ── One half-day saved ──────────────────────────────────────────────────────────────────────────

function expectedVersionOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 1 ? number : null;
}

/** The rep customers a single visit names: every one must sit on a territory of his district, in his world. */
async function assertDistrictCustomers(customerIds: ReadonlyArray<string>, districtSeatIds: ReadonlySet<string>, isTest: boolean): Promise<void> {
  if (customerIds.length === 0) return;
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, is_test").in("id", dedupeIds(customerIds)),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const found = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of customerIds) {
    const row = found.get(id);
    if (!row || row.is_test !== isTest) throw conflictError("A customer you chose is no longer on the list. Reload the page and choose again.");
    if (!districtSeatIds.has(String(row.seat_id ?? ""))) throw forbiddenError("A single visit names customers of your own district only.");
  }
}

/**
 * POST: set, change or clear ONE half-day of his own week. The screen sends the plan version it showed;
 * the database refuses the save when another screen moved the week first. Answers with the board as it
 * now stands.
 */
export async function saveManagerPlanSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerPlanBoardView> {
  const body = record(raw);
  const seat = assertManagerPlanWriter(viewer);
  await assertPlansHere(viewer);
  const isTest = testModeFor(viewer, body.test);
  const parsed = parseManagerSlotDraft(body);
  if (!parsed.ok) throw validationError(parsed.error);
  const draft = parsed.value;

  const holidays = await loadPlanHolidays(draft.date, draft.date);
  if (!managerDayHalves(draft.date, holidays.get(draft.date) ?? null).includes(draft.half)) {
    throw validationError(holidays.get(draft.date) ? `${holidays.get(draft.date)} is a public holiday, so it holds no plan.` : "This half-day is not a field half-day.");
  }

  let repSeat: OrgSeat | null = null;
  let areaSeat: OrgSeat | null = null;
  if (draft.kind === "with_rep") {
    repSeat = managerTeamSeats(viewer, viewer.hrId).find((entry) => entry.seatId === draft.repSeatId) ?? null;
    if (!repSeat) throw forbiddenError("Choose one of the reps of your own team.");
  }
  if (draft.kind === "single_visit") {
    const district = managerDistrictSeats(viewer, viewer.hrId);
    areaSeat = district.find((entry) => entry.seatId === draft.areaSeatId) ?? null;
    if (!areaSeat) throw forbiddenError("Choose an area of your own district.");
    await assertDistrictCustomers(
      draft.customers.flatMap((entry) => ("customerId" in entry ? [entry.customerId] : [])),
      new Set(district.map((entry) => entry.seatId)),
      isTest,
    );
  }

  await callPhoenixCrm<Row>("phoenix_crm_save_manager_plan_slot", {
    p: {
      manager_hr_id: viewer.hrId,
      manager_seat_id: seat.seatId,
      line_code: seat.lineCode,
      actor_hr_id: viewer.hrId,
      plan_date: draft.date,
      half: draft.half,
      kind: draft.kind,
      rep_seat_id: repSeat?.seatId ?? null,
      rep_hr_id: repSeat?.occupantHrId ?? null,
      activity_type: draft.activityType,
      area_seat_id: areaSeat?.seatId ?? null,
      area_code: areaSeat ? (areaSeat.areaCode ?? areaSeat.seatId) : null,
      area_name: areaSeat ? (areaSeat.areaName ?? territoryName(areaSeat)) : null,
      note: draft.note,
      customers: draft.customers.map((entry) => ("customerId" in entry ? { customer_id: entry.customerId } : { manager_customer_id: entry.managerCustomerId })),
      expected_version: expectedVersionOf(body.expectedVersion),
      is_test: isTest,
    },
  });

  return buildBoard(viewer, isTest, resolveManagerPlanReader(viewer, viewer.hrId), fieldWeekStart(draft.date));
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

/** The seat a notice about this plan is filed on: the seat the plan was filed on, or his seat now. */
function noticeSeat(viewer: Pick<PhoenixCrmViewer, "org">, plan: Pick<ManagerPlanRow, "managerSeatId" | "managerHrId">): OrgSeat | null {
  return viewer.org.seats.get(plan.managerSeatId) ?? managerPlanSeatOf(viewer, plan.managerHrId);
}

async function tellManagerPlan(viewer: Pick<PhoenixCrmViewer, "org">, plan: ManagerPlanRow, notice: Omit<ManagerPlanNotice, "kind" | "seat" | "managerHrId" | "weekStart" | "planId">, isTest: boolean): Promise<void> {
  const seat = noticeSeat(viewer, plan);
  if (!seat) return;
  await notifyPhoenixCrm({ kind: "manager_plan", seat, managerHrId: plan.managerHrId, weekStart: plan.weekStart, planId: plan.planId, ...notice }, isTest);
}

/**
 * POST: send his week (submit), or decide it (approve, return — the week or ONE day). The send is his
 * alone; a decision belongs to the approver stored on the row for its stage, or the Administrator in his
 * place. The approvers are read from the organogram at the send and stored on the row, so a week already
 * sent keeps going to the people it was sent to.
 */
export async function transitionManagerPlan(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerPlanTransitionResult> {
  const body = record(raw);
  const action = body.action;
  if (action !== "submit" && action !== "approve" && action !== "return") throw validationError("Choose Send, Approve or Return.");
  const planId = textOrNull(body.planId);
  if (!planId) throw validationError("This plan could not be read. Reload the page.");
  const isTest = testModeFor(viewer, body.test);
  const plan = await loadManagerPlanRow(planId, isTest);
  if (!plan) throw notFoundError("This plan is no longer there. Reload the page.");
  const note = noteOf(body.note);
  const expectedVersion = expectedVersionOf(body.version) ?? plan.version;

  if (action === "submit") {
    const seat = assertManagerPlanWriter(viewer);
    await assertPlansHere(viewer);
    if (plan.managerHrId !== viewer.hrId) throw forbiddenError("Only the district manager who owns this week can send it.");
    const approvers = managerPlanApprovers(viewer.org, seat.seatId);
    const result = record(
      await callPhoenixCrm<Row>("phoenix_crm_manager_plan_transition", {
        p: {
          plan_id: plan.planId,
          action: "submit",
          actor_hr_id: viewer.hrId,
          actor_role: "manager",
          first_approver_hr_id: approvers.first?.hrId ?? null,
          second_approver_hr_id: approvers.secondHrId,
          expected_version: expectedVersion,
          is_test: isTest,
        },
      }),
    );
    if (approvers.first) {
      await tellManagerPlan(
        viewer,
        plan,
        {
          step: "waiting",
          recipientHrId: approvers.first.hrId,
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
  if (action === "return" && !note) throw validationError("Write what should change, so the district manager knows.");

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
 * and his RSM/NSM approves the reopening — Hany for Hany's district managers; the week sent again then
 * goes Hany → Ali as before).
 */
export async function raiseManagerPlanEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; planId: string }> {
  const body = record(raw);
  const seat = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, body.test);
  const planId = textOrNull(body.planId);
  if (!planId) throw validationError("This plan could not be read. Reload the page.");
  const plan = await loadManagerPlanRow(planId, isTest);
  if (!plan || plan.managerHrId !== viewer.hrId) throw notFoundError("This plan is no longer there. Reload the page.");
  const reason = noteOf(body.reason);
  if (!reason || reason.length < 3) throw validationError("Write why you need to change the week.");
  const approver = managerPlanApprovers(viewer.org, seat.seatId).first;
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_raise_manager_plan_edit", {
      p: { plan_id: plan.planId, actor_hr_id: viewer.hrId, approver_hr_id: approver?.hrId ?? null, reason, is_test: isTest },
    }),
  );
  const requestId = String(result.request_id ?? "");
  if (approver && requestId) {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "edit_waiting", recipientHrId: approver.hrId, actorHrId: viewer.hrId, recordId: requestId, version: 1, note: reason, customerName: null, byAdministrator: false },
      isTest,
    );
  }
  return { requestId, planId: plan.planId };
}

/** POST: his approver — or the Administrator — reopens the week or refuses the ask. */
export async function decideManagerPlanEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; status: string; planStatus: string }> {
  const body = record(raw);
  const decision = body.decision;
  if (decision !== "reopen" && decision !== "refuse") throw validationError("Choose Reopen or Refuse.");
  const requestId = textOrNull(body.requestId);
  if (!requestId) throw validationError("This ask could not be read. Reload the page.");
  const isTest = testModeFor(viewer, body.test);
  const ask = await loadEditAskRow(requestId);
  if (!ask || ask.isTest !== isTest) throw notFoundError("This ask to edit is no longer there. Reload the page.");
  const role = managerAskDeciderRole(viewer, { approverHrId: ask.approverHrId, isTest });
  if (!role) throw forbiddenError("This ask is decided by the manager above the district manager.");
  const note = noteOf(body.note);
  if (decision === "refuse" && !note) throw validationError("Write why the week stays as it was sent.");
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_decide_manager_plan_edit", {
      p: {
        request_id: requestId,
        decision,
        actor_hr_id: viewer.hrId,
        actor_role: role,
        note,
        expected_version: expectedVersionOf(body.version) ?? ask.version,
        is_test: isTest,
      },
    }),
  );
  const plan = await loadManagerPlanRow(ask.planId, isTest);
  if (plan) {
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
