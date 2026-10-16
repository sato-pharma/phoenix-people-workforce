/**
 * Phoenix CRM — a rep's REQUEST for a double visit: raised by the last question of his visit, its days
 * edited (never cancelled), answered by each person asked, and read on the managers' report. The rules,
 * with no I/O, are double-visit-request-rules.ts; the database is the three
 * `phoenix_crm_*_double_visit_request*` functions (20261016133000).
 *
 * Owner, 2026-10-16: "the last question while rep logging a visit to an am or pm account must be: do
 * you need a double visit with this dr/account? … make him able to choose up to 3 timings, make him
 * then able to edit the timing but never cancel his request. After that a new sidebar report is
 * generated for managers which pumps notifications when they receive this request, and all managers
 * must have access on this report as per their scope up to the CEO."
 *
 * Gate two, after each route's `phoenix_crm` permission:
 *   - RAISE — only through the rep's own visit save (`saveVisit`, `enteredAs === "rep"`): there is no
 *     route that raises one;
 *   - EDIT THE DAYS — the territory's own rep and nobody else (`territoryForRepWrite`), compared with
 *     the rep recorded ON THE ROW. There is NO cancel function, route or button, deliberately;
 *   - ANSWER — the person recorded on the request as asked, and nobody else, read from the ROW and never
 *     from the body. The Super Admin answers nothing; a test login answers as the person it mirrors, in
 *     the test world only;
 *   - READ — the report: the Super Admin, the CEO and SFE read every territory in their scope; a
 *     manager reads the territories beneath him (scope runs DOWNWARD only); every person asked reads
 *     the requests addressed to him whatever his seat — which is how a product manager, who holds no
 *     seat, opens the report at all. The rep reads his own requests on his customer's page.
 *
 * 🔴 THE DISTRICT MANAGER'S OWN DOUBLE-VISIT PLAN IS NEVER READ OR WRITTEN HERE. A request is the REP's,
 * so its answers are his to see; the plan stays the manager's own, hidden from the rep.
 *
 * Every read and write is in ONE world: `is_test` on every query, and a test request tells the test
 * logins only (notifications.ts).
 */

import { isSamePerson } from "@/lib/auth/identity-aliases";
import { addDaysIso } from "@/lib/crm/dates";
import { ApiError, conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  doubleVisitTally,
  isDoubleVisitPersonStatus,
  isDoubleVisitRequestable,
  isDoubleVisitRole,
  parseDoubleVisitAnswer,
  resolveDoubleVisitDays,
  resolveDoubleVisitPeople,
  type DoubleVisitPerson,
  type DoubleVisitPersonStatus,
  type DoubleVisitRole,
} from "@/lib/phoenix-crm/double-visit-request-rules";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  canWriteAsRep,
  doubleVisitReportAudience,
  readTestFlag,
  territoryForRead,
  territoryForRepWrite,
  testModeFor,
  testReadSeats,
  type DoubleVisitReportAudience,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm, withdrawPhoenixCrmDoubleVisitWaitingNotices } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { personSeatTitle } from "@/lib/phoenix-crm/server/territory";
import { loadLineProductManagers } from "@/lib/phoenix-crm/server/visit-asks";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { visitAskDayChoices, visitAskLastDay } from "@/lib/phoenix-crm/visit-ask-rules";
import type { CompanyOffer } from "@/lib/phoenix-crm/visit-company";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

/** What a screen reads off a request: the customer and every person asked, in one read. */
const REQUEST_COLUMNS =
  "id, seat_id, customer_id, rep_hr_id, visit_id, days, edited_at, edit_count, is_test, created_at, updated_at, " +
  "customer:phoenix_crm_customers!customer_id(name, list_type), " +
  "people:phoenix_crm_double_visit_request_people(id, asked_hr_id, role, status, visit_on, answered_at)";

/** How long a request stays on the report: raised in the last 60 days. */
const REPORT_DAYS = 60;

/** At most this many requests of one customer travel to his page, newest first. */
const CUSTOMER_REQUESTS_MAX = 20;

// ── Who may be asked ────────────────────────────────────────────────────────────────────────────

/**
 * The people the rep is OFFERED on the last question — the managers above his territory (district, a
 * regional manager where his line has one, national) and the product managers of his line (the Group
 * Product Manager and, on CNS, the Marketing Manager). The very list "Who was on the visit" offers
 * (`visit-company.ts`), read here from the organogram and the line's product managers, never from the
 * phone. The rep himself is never on it.
 */
export async function loadDoubleVisitOffers(viewer: PhoenixCrmViewer, seat: OrgSeat, repHrId: string): Promise<CompanyOffer[]> {
  const rep = personKey(repHrId);
  const managers = managerChain(viewer.org, seat.seatId)
    .filter((member) => member.hrId !== rep)
    .map((member): CompanyOffer => ({ hrId: member.hrId, role: "manager", position: member.position }));
  const productManagers = (await loadLineProductManagers(seat))
    .filter((manager) => personKey(manager.hrId) !== rep)
    .map((manager): CompanyOffer => ({ hrId: manager.hrId, role: "product_manager", position: null }));
  return [...managers, ...productManagers];
}

// ── Raising one (from the visit save) ───────────────────────────────────────────────────────────

/** A request checked and ready to raise once the visit it belongs to is saved. */
export type PreparedDoubleVisitRequest = { people: DoubleVisitPerson[]; days: string[] };

/**
 * Read and check the last question's answer BEFORE the visit is saved, so a rep who ticked a person
 * that was never offered, or a day that is a Friday, is told while his visit is still on the screen
 * (a refusal after the save would leave him a saved visit and a request that did not happen).
 *
 * Null when the answer is No, when nothing was sent, or when somebody other than the rep entered the
 * visit — a manager entering his own double visit is on it already, and the Super Admin entering a
 * missed visit for a rep asks nothing on the rep's behalf.
 */
export async function prepareDoubleVisitRequest(
  viewer: PhoenixCrmViewer,
  input: { seat: OrgSeat; enteredAs: "rep" | "manager"; repHrId: string; raw: unknown },
): Promise<PreparedDoubleVisitRequest | null> {
  const answer = parseDoubleVisitAnswer(input.raw);
  if (!answer.wanted || input.enteredAs !== "rep") return null;
  const offers = await loadDoubleVisitOffers(viewer, input.seat, input.repHrId);
  const people = resolveDoubleVisitPeople({ picked: answer.hrIds, offers });
  if (!people.ok) throw validationError(people.error);
  const today = viewer.cairoToday;
  const holidays = await loadPlanHolidays(today, visitAskLastDay(today));
  const days = resolveDoubleVisitDays({ days: answer.days, cairoToday: today, holidays });
  if (!days.ok) throw validationError(days.error);
  return { people: people.people, days: days.days };
}

/** What the visit's saved banner says about the request it raised. */
export type DoubleVisitFromVisit = { created: boolean; names: string[] };

/**
 * Raise the request the last question asked for, once the visit is saved.
 *
 * 🔴 IT NEVER THROWS, AND IT NEVER COSTS THE REP HIS VISIT. The visit is already saved when this runs.
 * A customer who is a pharmacy, a database hiccup or a request already raised each leave the visit
 * exactly as saved; only a failure nobody expected is logged. Idempotent per visit: the database raises
 * at most one request per visit id, so a save sent twice — or retried after a dropped connection —
 * asks once and tells everyone once.
 */
export async function raiseDoubleVisitRequestFromVisit(
  viewer: PhoenixCrmViewer,
  input: {
    seat: OrgSeat;
    isTest: boolean;
    visitId: string;
    customerId: string;
    repHrId: string;
    listType: PhoenixCrmListType | string | null | undefined;
    prepared: PreparedDoubleVisitRequest;
  },
): Promise<DoubleVisitFromVisit | null> {
  const { seat, isTest, prepared } = input;
  // The question belongs to AM and PM accounts; a pharmacy visit never asks it.
  if (!isDoubleVisitRequestable(input.listType)) return null;
  try {
    const result = await callPhoenixCrm<Row>("phoenix_crm_raise_double_visit_request", {
      p: {
        seat_id: seat.seatId,
        line_code: seat.lineCode,
        customer_id: input.customerId,
        rep_hr_id: personKey(input.repHrId),
        visit_id: input.visitId,
        days: prepared.days,
        people: prepared.people.map((person) => ({ hr_id: person.hrId, role: person.role })),
        is_test: isTest,
      },
    });
    const askedHrIds = peopleOf(result).map((person) => person.hrId);
    if (result.created === true) {
      await notifyPhoenixCrm(
        {
          kind: "double_visit_request",
          seat,
          requestId: String(result.id),
          step: "raised",
          repHrId: personKey(input.repHrId) ?? input.repHrId,
          askedHrIds,
          customerName: textOrNull(result.customer_name) ?? "a customer",
          listType: parseListType(result.customer_list_type),
          days: daysOf(result.days),
          visitOn: null,
          version: 0,
        },
        isTest,
      );
    }
    const names = await loadPeopleNames(askedHrIds);
    return { created: result.created === true, names: askedHrIds.map((hrId) => nameOf(names, hrId, "your manager")) };
  } catch (error) {
    // A refusal the module wrote (a customer outside the list) is the expected quiet answer.
    if (!(error instanceof ApiError)) {
      logError("Phoenix CRM could not raise the double visit request a visit's last question asked for", {
        error,
        labels: { event: "phoenix_crm_double_visit_request_from_visit_failed", visitId: input.visitId },
      });
    }
    return null;
  }
}

function daysOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((day): day is string => typeof day === "string").map((day) => day.slice(0, 10)).sort() : [];
}

type RawPerson = { personId: string; hrId: string; role: DoubleVisitRole; status: DoubleVisitPersonStatus; visitOn: string | null; answeredAt: string | null };

function peopleOf(source: Row): RawPerson[] {
  const list = Array.isArray(source.people) ? (source.people as unknown[]) : [];
  const people: RawPerson[] = [];
  for (const entry of list) {
    const row = record(entry);
    const hrId = textOrNull(row.asked_hr_id) ?? textOrNull(row.hr_id);
    if (!hrId) continue;
    people.push({
      personId: textOrNull(row.id) ?? "",
      hrId,
      role: isDoubleVisitRole(row.role) ? row.role : "manager",
      status: isDoubleVisitPersonStatus(row.status) ? row.status : "waiting",
      visitOn: textOrNull(row.visit_on)?.slice(0, 10) ?? null,
      answeredAt: textOrNull(row.answered_at),
    });
  }
  return people;
}

// ── Who answers, and who reads ──────────────────────────────────────────────────────────────────

/** What a request is to the identity gate: who it asks, in which world. Read from the row. */
export type DoubleVisitGateRow = { askedHrId: string; isTest: boolean };

/**
 * Whether this viewer may answer as this person asked. Compared as a person, never as a raw id
 * (identity-aliases.ts). In the test world a test login answers as the person it mirrors; a real request
 * is answered by its real person alone — and the Super Admin, who decides no real entry, answers none.
 */
export function canAnswerDoubleVisit(viewer: PhoenixCrmViewer, row: DoubleVisitGateRow): boolean {
  if (viewer.isSuperAdmin) return false;
  if (row.isTest !== viewer.isTestPersona) return false;
  return isSamePerson(viewer.hrId, row.askedHrId);
}

/** The assert twin. Everything it compares comes from the row. */
export function assertDoubleVisitAnswerer(viewer: PhoenixCrmViewer, row: DoubleVisitGateRow): void {
  if (canAnswerDoubleVisit(viewer, row)) return;
  if (!row.isTest && viewer.isTestPersona) throw forbiddenError("This is a test login: it works on test entries only. Real entries stay as they are.");
  throw forbiddenError("Only a person asked answers this request.");
}

/**
 * Who opens the report is `doubleVisitReportAudience` in access.ts (owner, 2026-10-16: "all managers must
 * have access on this report as per their scope up to the CEO") — it lives there so the portal sidebar can
 * ask it without loading this service. Re-exported so the service's callers keep one import.
 */
export { doubleVisitReportAudience, type DoubleVisitReportAudience } from "@/lib/phoenix-crm/server/access";

// ── What the screens read ───────────────────────────────────────────────────────────────────────

/** One person asked, on a screen. Names, never codes; the person's id is the answer button's key. */
export type DoubleVisitPersonView = {
  personId: string;
  name: string;
  /** His organogram title ("District Sales Manager"). Null for a product manager, who holds no seat. */
  title: string | null;
  role: DoubleVisitRole;
  status: DoubleVisitPersonStatus;
  visitOn: string | null;
  answeredAt: string | null;
  isYou: boolean;
};

export type DoubleVisitRequestView = {
  requestId: string;
  seatId: string;
  territoryName: string;
  repName: string;
  customerName: string;
  customerListType: PhoenixCrmListType;
  /** The days the rep offers, earliest first. */
  days: string[];
  raisedAt: string;
  editedAt: string | null;
  people: DoubleVisitPersonView[];
  tally: { waiting: number; accepted: number; declined: number };
  /** The viewer is the person asked on this request: his own entry. */
  you: DoubleVisitPersonView | null;
  /** The viewer answers it now (he is asked, and it is his world). */
  canAnswer: boolean;
  /** The viewer is the rep who raised it, and may edit its days. There is no cancel. */
  isMine: boolean;
};

function mapRequest(row: Row, viewer: PhoenixCrmViewer, names: Awaited<ReturnType<typeof loadPeopleNames>>): DoubleVisitRequestView {
  const customer = record(Array.isArray(row.customer) ? row.customer[0] : row.customer);
  const seatId = String(row.seat_id);
  const seat = viewer.org.seats.get(seatId);
  const isTest = row.is_test === true;
  const people = peopleOf(row).map(
    (person): DoubleVisitPersonView => ({
      personId: person.personId,
      name: nameOf(names, person.hrId, "The person asked"),
      title: person.role === "manager" ? personSeatTitle(viewer.org, person.hrId) : null,
      role: person.role,
      status: person.status,
      visitOn: person.visitOn,
      answeredAt: person.answeredAt,
      isYou: isSamePerson(viewer.hrId, person.hrId),
    }),
  );
  const you = people.find((person) => person.isYou) ?? null;
  const yourRaw = peopleOf(row).find((person) => isSamePerson(viewer.hrId, person.hrId));
  return {
    requestId: String(row.id),
    seatId,
    territoryName: seat ? territoryName(seat) : "A territory no longer in the organogram",
    repName: nameOf(names, textOrNull(row.rep_hr_id), "A rep"),
    customerName: textOrNull(customer.name) ?? "Customer",
    customerListType: parseListType(customer.list_type),
    days: daysOf(row.days),
    raisedAt: String(row.created_at),
    editedAt: textOrNull(row.edited_at),
    people: people.sort((left, right) => Number(left.role === "product_manager") - Number(right.role === "product_manager") || left.name.localeCompare(right.name)),
    tally: doubleVisitTally(people),
    you,
    canAnswer: yourRaw ? canAnswerDoubleVisit(viewer, { askedHrId: yourRaw.hrId, isTest }) : false,
    isMine: isSamePerson(viewer.hrId, textOrNull(row.rep_hr_id)) && !viewer.isSuperAdmin && isTest === viewer.isTestPersona,
  };
}

function requestPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [textOrNull(row.rep_hr_id), ...peopleOf(row).map((person) => person.hrId)]);
}

/** Waiting for the viewer first, then the newest. */
function byYourTurnThenNewest(left: DoubleVisitRequestView, right: DoubleVisitRequestView): number {
  return Number(right.canAnswer && right.you?.status === "waiting") - Number(left.canAnswer && left.you?.status === "waiting") || right.raisedAt.localeCompare(left.raisedAt);
}

// ── The rep's own page ──────────────────────────────────────────────────────────────────────────

export type DoubleVisitCustomerView = {
  isTest: boolean;
  customerId: string;
  /** The viewer is the territory's rep: he may edit the days of his own requests. */
  canEdit: boolean;
  /** The days he may offer when he edits: today to four weeks on, never a Friday or a public holiday. */
  dayChoices: string[];
  requests: DoubleVisitRequestView[];
};

async function loadCustomerRequestRows(seatId: string, customerId: string, isTest: boolean): Promise<Row[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_double_visit_requests")
    .select(REQUEST_COLUMNS)
    .eq("seat_id", seatId)
    .eq("customer_id", customerId)
    .eq("is_test", isTest)
    .order("created_at", { ascending: false })
    .limit(CUSTOMER_REQUESTS_MAX);
  throwIfError(error);
  return (data ?? []) as unknown as Row[];
}

/** GET: one customer's double-visit requests, and whether the viewer may edit their days. */
export async function loadDoubleVisitCustomerView(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; customerId: unknown; test: unknown },
): Promise<DoubleVisitCustomerView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const customerId = typeof raw.customerId === "string" ? raw.customerId.trim().toLowerCase() : "";
  if (!isUuid(customerId)) throw validationError("Choose a customer.");
  const rows = await loadCustomerRequestRows(seat.seatId, customerId, isTest);
  const canEdit = canWriteAsRep(viewer, seat, isTest);
  const today = viewer.cairoToday;
  const holidays = canEdit && rows.length > 0 ? await loadPlanHolidays(today, visitAskLastDay(today)) : new Map<string, string>();
  const names = await loadPeopleNames(requestPeople(rows));
  return {
    isTest,
    customerId,
    canEdit,
    dayChoices: canEdit ? visitAskDayChoices(today, holidays) : [],
    requests: rows.map((row) => mapRequest(row, viewer, names)),
  };
}

// ── Editing the days (never cancelling) ─────────────────────────────────────────────────────────

async function loadRequestRow(requestId: string): Promise<Row | null> {
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_double_visit_requests").select(REQUEST_COLUMNS).eq("id", requestId).maybeSingle();
  throwIfError(error);
  return (data as unknown as Row | null) ?? null;
}

/**
 * POST: the rep changes the days of a request he raised — and that is ALL he can do to it. There is no
 * cancel (owner, 2026-10-16: "never cancel his request"). The territory's own rep, in the request's own
 * world, compared with the rep recorded on the row. The people still waiting are told the new days;
 * a person whose accepted day the rep dropped goes back to waiting and is asked again.
 */
export async function editDoubleVisitRequestDays(viewer: PhoenixCrmViewer, raw: unknown): Promise<DoubleVisitCustomerView> {
  const body = record(raw);
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().toLowerCase() : "";
  if (!isUuid(requestId)) throw validationError("Choose the request. Reload the page.");
  const row = await loadRequestRow(requestId);
  if (!row) throw notFoundError("This request is no longer there. Reload the page.", "phoenix_crm_double_visit_not_found");
  const rowIsTest = row.is_test === true;
  const { seat, isTest } = territoryForRepWrite(viewer, row.seat_id, rowIsTest);
  // A test login edits test requests only — never a real one, whatever its own seat.
  if (isTest !== rowIsTest) throw forbiddenError("This is a test login: it works on test entries only. Real entries stay as they are.");
  if (!isSamePerson(viewer.hrId, textOrNull(row.rep_hr_id))) throw forbiddenError("Only the rep who raised this request changes its days.");

  const today = viewer.cairoToday;
  const holidays = await loadPlanHolidays(today, visitAskLastDay(today));
  const days = resolveDoubleVisitDays({ days: body.days, cairoToday: today, holidays });
  if (!days.ok) throw validationError(days.error);

  const result = await callPhoenixCrm<Row>("phoenix_crm_edit_double_visit_request_days", {
    p: { request_id: requestId, seat_id: seat.seatId, actor_hr_id: viewer.hrId, days: days.days, is_test: isTest },
  });
  if (result.changed === true) {
    const after = await loadRequestRow(requestId);
    const waiting = peopleOf(result).filter((person) => person.status === "waiting");
    if (waiting.length > 0) {
      await notifyPhoenixCrm(
        {
          kind: "double_visit_request",
          seat,
          requestId,
          step: "days_changed",
          repHrId: String(row.rep_hr_id),
          askedHrIds: waiting.map((person) => person.hrId),
          customerName: textOrNull(result.customer_name) ?? "a customer",
          listType: parseListType(result.customer_list_type),
          days: daysOf(result.days),
          visitOn: null,
          version: Number(after?.edit_count ?? 1),
        },
        isTest,
      );
    }
  }
  return loadDoubleVisitCustomerView(viewer, { seatId: seat.seatId, customerId: String(row.customer_id), test: isTest });
}

// ── Answering ───────────────────────────────────────────────────────────────────────────────────

/**
 * POST: a person asked accepts ONE of the rep's days, or declines. Identity from the ROW
 * (`assertDoubleVisitAnswerer`); the day must be one the rep offered (checked here and again in the
 * database) and one that has not passed. The rep is told which person answered and what; the person's
 * own "accept or decline" notice goes. Each person answers on his own — the others stay as they are.
 */
export async function answerDoubleVisitRequest(viewer: PhoenixCrmViewer, raw: unknown): Promise<DoubleVisitReport> {
  const body = record(raw);
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().toLowerCase() : "";
  if (!isUuid(requestId)) throw validationError("Choose the request. Reload the page.");
  const decision = body.decision === "accept" ? "accept" : body.decision === "decline" ? "decline" : null;
  if (!decision) throw validationError("Choose accept or decline.");

  const row = await loadRequestRow(requestId);
  if (!row) throw notFoundError("This request is no longer there. Reload the page.", "phoenix_crm_double_visit_not_found");
  const isTest = row.is_test === true;
  const you = peopleOf(row).find((person) => isSamePerson(viewer.hrId, person.hrId));
  if (!you) throw forbiddenError("Only a person asked answers this request.");
  assertDoubleVisitAnswerer(viewer, { askedHrId: you.hrId, isTest });

  let visitOn: string | null = null;
  if (decision === "accept") {
    const day = typeof body.day === "string" ? body.day.trim() : "";
    if (!isIsoDay(day)) throw validationError("Choose the day of the visit.");
    if (!daysOf(row.days).includes(day)) throw validationError("Choose one of the days the rep offered. Reload the page.");
    if (day < viewer.cairoToday) throw conflictError("This day has passed. Choose another day the rep offered.", "phoenix_crm_double_visit_bad_day");
    visitOn = day;
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_answer_double_visit_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, decision, visit_on: visitOn, is_test: isTest },
  });
  // His "accept or decline" lines have done their job.
  await withdrawPhoenixCrmDoubleVisitWaitingNotices(requestId, you.hrId);

  const seat = viewer.org.seats.get(String(row.seat_id));
  const customer = record(Array.isArray(row.customer) ? row.customer[0] : row.customer);
  if (seat) {
    await notifyPhoenixCrm(
      {
        kind: "double_visit_request",
        seat,
        requestId,
        step: result.status === "accepted" ? "accepted" : "declined",
        repHrId: String(row.rep_hr_id),
        askedHrIds: [you.hrId],
        customerName: textOrNull(result.customer_name) ?? textOrNull(customer.name) ?? "the customer",
        listType: parseListType(customer.list_type),
        days: daysOf(row.days),
        visitOn: textOrNull(result.visit_on)?.slice(0, 10) ?? null,
        version: Number(row.edit_count ?? 0),
      },
      isTest,
    );
  }
  return loadDoubleVisitReport(viewer, { test: isTest });
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

export type DoubleVisitReport = {
  isTest: boolean;
  audience: DoubleVisitReportAudience;
  /** Waiting for the viewer's own answer, the longest-waiting first. */
  toAnswer: DoubleVisitRequestView[];
  /** Everything else he reads, newest first. */
  others: DoubleVisitRequestView[];
  /** Every request he reads is counted here, by what the people asked have answered. */
  totals: { requests: number; waiting: number; accepted: number; declined: number };
};

/** Requests on these territories in one world, raised since `since`. A keyset page per chunk of seats. */
async function loadScopeRequestRows(seatIds: ReadonlyArray<string>, isTest: boolean, since: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk([...seatIds], 100)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_double_visit_requests")
            .select(REQUEST_COLUMNS)
            .in("seat_id", part)
            .eq("is_test", isTest)
            .gte("created_at", `${since}T00:00:00Z`),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

/** The requests addressed to one person, in one world: his rows on the people table, then their requests. */
async function loadAddressedRequestRows(hrId: string, isTest: boolean, since: string): Promise<Row[]> {
  const people = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_double_visit_request_people").select("id, request_id").eq("asked_hr_id", hrId).eq("is_test", isTest),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const requestIds = [...new Set(people.map((row) => String(row.request_id)))];
  const rows: Row[] = [];
  for (const part of chunk(requestIds, 100)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_double_visit_requests")
            .select(REQUEST_COLUMNS)
            .in("id", part)
            .gte("created_at", `${since}T00:00:00Z`),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

/** GET: the double-visit requests the viewer answers or reads — the managers' sidebar report. */
export async function loadDoubleVisitReport(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<DoubleVisitReport> {
  const isTest = testModeFor(viewer, raw.test);
  const audience = doubleVisitReportAudience(viewer);
  if (!audience) throw forbiddenError("Double visit requests are for managers, product managers and SFE. A rep reads his own on the customer's page.");
  const since = addDaysIso(viewer.cairoToday, -REPORT_DAYS);

  const addressed = await loadAddressedRequestRows(viewer.hrId, isTest, since);
  const scoped = audience === "scope" ? await loadScopeRequestRows(testReadSeats(viewer, isTest, viewer.scopeTerritories).map((seat) => seat.seatId), isTest, since) : [];
  const byId = new Map<string, Row>();
  for (const row of [...scoped, ...addressed]) byId.set(String(row.id), row);
  const rows = [...byId.values()];

  const names = await loadPeopleNames(requestPeople(rows));
  const views = rows.map((row) => mapRequest(row, viewer, names));
  const toAnswer = views
    .filter((view) => view.canAnswer && view.you?.status === "waiting")
    .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt));
  const answeringIds = new Set(toAnswer.map((view) => view.requestId));
  const others = views.filter((view) => !answeringIds.has(view.requestId)).sort(byYourTurnThenNewest);
  const totals = { requests: views.length, waiting: 0, accepted: 0, declined: 0 };
  for (const view of views) {
    totals.waiting += view.tally.waiting;
    totals.accepted += view.tally.accepted;
    totals.declined += view.tally.declined;
  }
  return { isTest, audience, toAnswer, others, totals };
}
