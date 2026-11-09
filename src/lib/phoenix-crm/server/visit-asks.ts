/**
 * Phoenix CRM — a rep's ask for a visit with somebody: raising one, answering one, taking one back, and
 * who reads which. The rules, with no I/O, are visit-ask-rules.ts.
 *
 * Owner, 2026-10-02, in his own words: "the medical rep can request a double visit with his manager /
 * product manager / or request a chain visit to a certain dr" — and the visit next step "Arrange a
 * double visit", which nothing read until now, raises the double ask by itself, once per visit.
 *
 * Gate two, after each route's `phoenix_crm` permission:
 *   - RAISE and CANCEL — the territory's own rep (`territoryForRepWrite`): the Super Admin in the test
 *     world only, and a test account as the rep it mirrors, in the test world only;
 *   - ANSWER — the person recorded on the row as asked, and nobody else, read from the ROW and never
 *     from the body (`assertVisitAskAnswerer`). In the test world the Super Admin answers any test ask
 *     and a test account answers as the person it mirrors; a real ask is never answered by a test
 *     login, nor by the Super Admin, who decides no real entry;
 *   - READ — the rep reads the asks on his customer's page through the list's own seat gate
 *     (`territoryForRead`); the person asked and the person told read theirs; SFE and the Super Admin
 *     read every ask in their scope (`visitAskInboxReach`). Scope never runs upward: a manager reads the
 *     asks addressed to him or told to him, never a sibling's.
 *
 * 🔴 THE ANSWER ROUTE ASKS FOR `read`, AND THAT IS THE NARROWEST GATE THAT SERVES IT. A product manager
 * — and the Marketing Manager, whom CNS reps may ask (the owner's CNS rule, visit-ask-rules.ts) —
 * holds `phoenix_crm: read` and nothing else — `create`, `update` and `approve` are what
 * resolvePhoenixCrmViewer turns into entering visits and deciding a territory's requests, and widening
 * his role to answer one ask would hand him those. So gate one is the permission every person the route
 * serves already holds, and gate two is IDENTITY, from the row. The access registry declares it `read`,
 * audited as a mutation — the same shape as the direct-order sales month, whose real gate is an
 * identity check too.
 *
 * 🔴 THE DISTRICT MANAGER'S OWN DOUBLE-VISIT PLAN IS NEVER READ HERE. An ask is the REP's request, so
 * its status is his to see ("accepted, Tue 6 Oct"); the plan stays the manager's own, hidden from the
 * rep (owner, 2026-10-02).
 *
 * Every read and write is in ONE world: `is_test` on every query, and a test ask tells the test logins
 * only (notifications.ts).
 */

import { unstable_cache } from "next/cache";

import { isSamePerson } from "@/lib/auth/identity-aliases";
import { scopeForRole, type AccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { serveWithoutCaching, unwrapServedWithoutCaching } from "@/lib/cache/serve-uncached";
import { addDaysIso } from "@/lib/crm/dates";
import { activeRoleSignIns } from "@/lib/employees/role-lookup";
import { ApiError, conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import {
  isVisitAskAskableRole,
  isVisitAskKind,
  isVisitAskOpen,
  isVisitAskStatus,
  productManagersOfLine,
  resolveVisitAskAddressees,
  resolveVisitAskDay,
  VISIT_ASK_ASKABLE_ROLES,
  VISIT_ASK_KIND_LABELS,
  VISIT_ASK_KINDS,
  VISIT_ASK_TRAINING_MANAGER_ROLE,
  visitAskDayChoices,
  visitAskLastDay,
  visitAskPartOf,
  wishedVisitAskDay,
  type ProductManagerReach,
  type VisitAskAddresseeResult,
  type VisitAskKind,
  type VisitAskPart,
  type VisitAskProductManager,
  type VisitAskStatus,
} from "@/lib/phoenix-crm/visit-ask-rules";
import {
  canWriteAsRep,
  readTestFlag,
  territoryForRead,
  territoryForRepWrite,
  territoryForView,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { productOwnerFamilies } from "@/lib/phoenix-crm/server/insight-reports";
import { notifyPhoenixCrm, withdrawPhoenixCrmVisitAskNotices } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { personSeatTitle } from "@/lib/phoenix-crm/server/territory";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

/** What a screen reads off an ask, and the customer it is for. */
const ASK_COLUMNS =
  "id, seat_id, customer_id, kind, rep_hr_id, asked_hr_id, told_hr_id, wished_on, visit_id, status, visit_on, " +
  "answered_by_hr_id, answered_at, cancelled_at, is_test, created_at, updated_at, " +
  "customer:phoenix_crm_customers!customer_id(name, list_type)";

/** How long an ask that no longer waits stays on the inbox: answered or cancelled in the last 30 days. */
const INBOX_DAYS = 30;

/** At most this many asks of one customer travel to his page, newest first. */
const CUSTOMER_ASKS_MAX = 20;

// ── The product managers of a line ──────────────────────────────────────────────────────────────

/**
 * Every person an ask for a product manager's visit can be addressed to — the app roles Product Manager
 * and Group Product Manager, and the Marketing Manager, whom the owner's CNS rule offers on CNS alone —
 * with the products he owns: the field-heard report's own rule (`productOwnerFamilies`), read with each
 * person's OWN access context, exactly as it would be read for him. WHICH of them a line offers is
 * visit-ask-rules.ts `productManagersOfLine`, never this list. Someone who has left keeps a sign-in until
 * it is switched off, so only a person whose employee record is current is offered; a person whose
 * scope cannot be read is left out, and said so in the log.
 *
 * Cached five minutes: it reads the sales scope of every one of them, and a rep opens a customer's page
 * many times a day while a product manager's products change a few times a year. The key changed with
 * the CNS rule (v2), so a list read before it never answers for it.
 */
const cachedProductManagerReach = unstable_cache(
  async (): Promise<ProductManagerReach[]> => {
    const holders = await activeRoleSignIns(VISIT_ASK_ASKABLE_ROLES);
    if (holders.length === 0) return [];
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, employment_status")
      .in("hr_id", [...new Set(holders.map((holder) => holder.hrId))]);
    throwIfError(error);
    const current = new Set<string>();
    for (const row of (data ?? []) as Row[]) {
      const hrId = personKey(textOrNull(row.hr_id));
      if (hrId && !isTerminalEmploymentStatus(textOrNull(row.employment_status))) current.add(hrId);
    }
    const reach: ProductManagerReach[] = [];
    let missedSomeone = false;
    for (const holder of holders) {
      const hrId = personKey(holder.hrId);
      if (!hrId || !current.has(hrId)) continue;
      // The Training Manager owns no products: she is offered on every line by her role (visit-ask-rules.ts).
      if (holder.role === VISIT_ASK_TRAINING_MANAGER_ROLE) {
        reach.push({ hrId, role: holder.role, families: null });
        continue;
      }
      const access: AccessContext = { hrId, loginId: holder.loginId, role: holder.role, scope: scopeForRole(holder.role), source: "system" };
      try {
        const products = await productOwnerFamilies({ access });
        reach.push({ hrId, role: holder.role, families: products.families === null ? null : [...products.families] });
      } catch (caught) {
        logError("Phoenix CRM could not read a product manager's products for the visit asks", {
          error: caught,
          labels: { event: "phoenix_crm_visit_ask_product_manager_failed", hrId },
        });
        missedSomeone = true;
      }
    }
    // A list with somebody left out is offered to this one rep, never kept: cached, that product
    // manager would vanish from every rep's picker for five minutes over one failed read.
    if (missedSomeone) serveWithoutCaching(reach, "a product manager's products could not be read");
    return reach;
  },
  // v3: the Training Manager joined the list (owner, 2026-10-24); v2 the CNS rule.
  ["phoenix-crm-visit-ask-product-managers-v3"],
  { revalidate: 300 },
);

/**
 * The product managers a rep of this territory's line may pick, by the field-heard report's rule and
 * the line's own roles (visit-ask-rules.ts `productManagersOfLine` — the Marketing Manager on CNS only).
 * Never throws: a list that cannot be read offers nobody, which is the safe direction — the rep can
 * still ask his manager.
 */
export async function loadLineProductManagers(seat: Pick<OrgSeat, "lineCode" | "lineName">): Promise<VisitAskProductManager[]> {
  try {
    const [reach, families] = await Promise.all([
      unwrapServedWithoutCaching(cachedProductManagerReach()),
      lineProductsByFamily(seat.lineName),
    ]);
    return productManagersOfLine(
      reach,
      families.map((entry) => entry.family),
      seat.lineCode,
    );
  } catch (error) {
    logError("Phoenix CRM could not read the line's product managers for the visit asks", {
      error,
      labels: { event: "phoenix_crm_visit_ask_product_managers_failed", line: seat.lineName ?? "none" },
    });
    return [];
  }
}

// ── Who answers, and who reads ──────────────────────────────────────────────────────────────────

/** What an ask is to the identity gate: who it asks, in which world, where it stands. Read from the row. */
export type VisitAskGateRow = { askedHrId: string; isTest: boolean; status: VisitAskStatus };

/**
 * Whether this viewer may answer this ask, as it stands — the screen's twin of `assertVisitAskAnswerer`.
 * Only a waiting ask, and only by the person RECORDED ON THE ROW as asked: compared as a person, never
 * as a raw id (identity-aliases.ts). In the test world the Super Admin takes every step and a test
 * account answers as the person it mirrors; a real ask is answered by its real person alone.
 */
export function canAnswerVisitAsk(viewer: PhoenixCrmViewer, row: VisitAskGateRow): boolean {
  if (row.status !== "waiting") return false;
  if (row.isTest) {
    if (viewer.isTestPersona) return isSamePerson(viewer.hrId, row.askedHrId);
    return viewer.isSuperAdmin;
  }
  if (viewer.isTestPersona || viewer.isSuperAdmin) return false;
  return isSamePerson(viewer.hrId, row.askedHrId);
}

/** The assert twin. Everything it compares comes from the row. */
export function assertVisitAskAnswerer(viewer: PhoenixCrmViewer, row: VisitAskGateRow): void {
  if (row.status === "cancelled") throw conflictError("The rep cancelled this ask. Reload the page.", "phoenix_crm_visit_ask_cancelled");
  if (row.status !== "waiting") throw conflictError("This ask was already answered. Reload the page.", "phoenix_crm_visit_ask_answered");
  if (canAnswerVisitAsk(viewer, row)) return;
  if (row.isTest && !viewer.isSuperAdmin && !viewer.isTestPersona) throw forbiddenError("Test entries are the Super Admin's.");
  if (!row.isTest && viewer.isTestPersona) {
    throw forbiddenError("This is a test login: it works on test entries only. Real entries stay as they are.");
  }
  if (!row.isTest && viewer.isSuperAdmin) {
    throw forbiddenError("Only the person asked answers this ask. The Super Admin answers test entries only.");
  }
  throw forbiddenError("Only the person asked answers this ask.");
}

/** Whose asks the viewer reads: "own" — the ones addressed or told to him; "all" — every one in scope. */
export type VisitAskInboxReach = { mode: "own" | "all"; canAnswer: boolean };

/**
 * Who opens the asks inbox in `isTest`'s world. The people an ask can reach — a manager on a seat of
 * the organogram, and by his app role a product manager or the Marketing Manager (asked on CNS, the
 * owner's CNS rule) — read their own: an empty inbox when nobody has asked them, never a refusal. SFE
 * reads every real ask on the open lines and answers none; the Super Admin reads every ask, and answers
 * only in the test world. Null for everyone else — a rep reads his own asks on his customer's page,
 * never here.
 */
export function visitAskInboxReach(viewer: PhoenixCrmViewer, isTest: boolean): VisitAskInboxReach | null {
  if (viewer.isSuperAdmin && !viewer.isTestPersona) return { mode: "all", canAnswer: isTest };
  // SFE reads the real asks. The test world is the Super Admin's and the test accounts'.
  if (viewer.isSfeManager && !viewer.isTestPersona) return isTest ? null : { mode: "all", canAnswer: false };
  const reachable = viewer.managerSeats.length > 0 || isVisitAskAskableRole(viewer.role);
  if (!reachable) return null;
  // A test account is in the test world only; a real person in the real world only.
  if (viewer.isTestPersona !== isTest) return null;
  return { mode: "own", canAnswer: true };
}

// ── What the screens read ───────────────────────────────────────────────────────────────────────

/** One ask on a screen. Names, never codes; the ask's id is the buttons' key. */
export type VisitAskView = {
  askId: string;
  kind: VisitAskKind;
  kindLabel: string;
  status: VisitAskStatus;
  seatId: string;
  territoryName: string;
  repName: string;
  customerName: string;
  customerListType: PhoenixCrmListType;
  /**
   * The person who answers it, and his organogram title ("District Sales Manager"). Null for a product
   * manager's visit: the person asked holds an app role and no seat — a product manager, or on CNS the
   * Marketing Manager — so the screens name the VISIT ("Product manager visit"), never a title for him.
   */
  askedName: string;
  askedTitle: string | null;
  /** The person told: the manager above (chain), the rep's district manager (product manager). */
  toldName: string | null;
  wishedOn: string | null;
  /** The day the person asked picked, once accepted. */
  visitOn: string | null;
  raisedAt: string;
  answeredAt: string | null;
  /** Raised by a visit's next step "Arrange a double visit", rather than from the customer's page. */
  fromVisit: boolean;
  /** Where the viewer stands on it. */
  part: VisitAskPart;
  /** The viewer answers it now. */
  canAnswer: boolean;
};

function askPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [textOrNull(row.rep_hr_id), textOrNull(row.asked_hr_id), textOrNull(row.told_hr_id)]);
}

/**
 * A person's title on an ask: his organogram seat's, at the higher of his seats ("District Sales
 * Manager"). None for a product manager's visit — the person asked holds no seat, and is not always a
 * product manager (on CNS he is the Marketing Manager), so no title is better than a wrong one.
 */
function titleOf(viewer: PhoenixCrmViewer, kind: VisitAskKind, hrId: string | null): string | null {
  if (!personKey(hrId) || kind === "product_manager") return null;
  return personSeatTitle(viewer.org, hrId);
}

function mapAsk(row: Row, viewer: PhoenixCrmViewer, names: PeopleNames): VisitAskView {
  const kind: VisitAskKind = isVisitAskKind(row.kind) ? row.kind : "double";
  const status: VisitAskStatus = isVisitAskStatus(row.status) ? row.status : "waiting";
  const customer = record(Array.isArray(row.customer) ? row.customer[0] : row.customer);
  const seatId = String(row.seat_id);
  const seat = viewer.org.seats.get(seatId);
  const askedHrId = textOrNull(row.asked_hr_id);
  const toldHrId = textOrNull(row.told_hr_id);
  const gate: VisitAskGateRow = { askedHrId: askedHrId ?? "", isTest: row.is_test === true, status };
  return {
    askId: String(row.id),
    kind,
    kindLabel: VISIT_ASK_KIND_LABELS[kind],
    status,
    seatId,
    territoryName: seat ? territoryName(seat) : "A territory no longer in the organogram",
    repName: nameOf(names, textOrNull(row.rep_hr_id), "A rep"),
    customerName: textOrNull(customer.name) ?? "Customer",
    customerListType: parseListType(customer.list_type),
    askedName: nameOf(names, askedHrId, "The person asked"),
    askedTitle: titleOf(viewer, kind, askedHrId),
    toldName: toldHrId ? nameOf(names, toldHrId, "The manager above") : null,
    wishedOn: textOrNull(row.wished_on)?.slice(0, 10) ?? null,
    visitOn: textOrNull(row.visit_on)?.slice(0, 10) ?? null,
    raisedAt: String(row.created_at),
    answeredAt: textOrNull(row.answered_at),
    fromVisit: textOrNull(row.visit_id) !== null,
    part: visitAskPartOf({ askedHrId, toldHrId }, viewer.hrId),
    canAnswer: canAnswerVisitAsk(viewer, gate),
  };
}

/** Waiting first, then the newest. */
function byWaitingThenNewest(left: VisitAskView, right: VisitAskView): number {
  return Number(right.status === "waiting") - Number(left.status === "waiting") || right.raisedAt.localeCompare(left.raisedAt);
}

// ── The customer's page ─────────────────────────────────────────────────────────────────────────

/** One kind the rep may ask for on this customer, and who it would go to. */
export type VisitAskOffer = {
  kind: VisitAskKind;
  /** Whether it can be asked at all — false with a sentence when the organogram has nobody to ask. */
  available: boolean;
  reason: string | null;
  /** Who answers it (null for a product manager's, whom the rep picks), and who is told. */
  askedName: string | null;
  toldName: string | null;
  /** An ask of this kind already in play — waiting, or accepted for a day to come. Asked once, not twice. */
  open: VisitAskView | null;
};

export type VisitAskCustomerView = {
  isTest: boolean;
  customerId: string;
  /** The viewer is the territory's rep (or the Super Admin trying it) and the customer is on the list. */
  canAsk: boolean;
  offers: VisitAskOffer[];
  /** His line's product managers, by name. The hr id is the picker's key; the screen shows the name. */
  productManagers: Array<{ hrId: string; name: string; title: string }>;
  /** The days he may wish for: today to four weeks on, never a Friday, never a public holiday. */
  wishDays: string[];
  /** His asks for this customer, waiting first, then the newest. A cancelled one is gone from here. */
  asks: VisitAskView[];
};

async function loadCustomerAskRows(seatId: string, customerId: string, isTest: boolean): Promise<Row[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visit_asks")
    .select(ASK_COLUMNS)
    .eq("seat_id", seatId)
    .eq("customer_id", customerId)
    .eq("is_test", isTest)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(CUSTOMER_ASKS_MAX);
  throwIfError(error);
  return (data ?? []) as unknown as Row[];
}

/** The customer, on this territory and in this world — or a refusal. */
async function loadAskCustomer(seatId: string, customerId: string, isTest: boolean): Promise<Row> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, status")
    .eq("id", customerId)
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .maybeSingle();
  throwIfError(error);
  if (!data) throw notFoundError("This customer is not on the territory's list. Reload the list.");
  return data as Row;
}

/** GET: one customer's asks and what the rep may ask for, on the customer's page. */
export async function loadVisitAskCustomerView(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; customerId: unknown; test: unknown },
): Promise<VisitAskCustomerView> {
  const { seat, isTest } = territoryForView(viewer, raw.seatId, readTestFlag(raw.test));
  const customerId = typeof raw.customerId === "string" ? raw.customerId.trim().toLowerCase() : "";
  if (!isUuid(customerId)) throw validationError("Choose a customer.");
  const customer = await loadAskCustomer(seat.seatId, customerId, isTest);
  const onList = customer.status === "active" || customer.status === "pending";
  const canAsk = onList && canWriteAsRep(viewer, seat, isTest);
  const today = viewer.cairoToday;

  const [rows, productManagers, holidays] = await Promise.all([
    loadCustomerAskRows(seat.seatId, customerId, isTest),
    canAsk ? loadLineProductManagers(seat) : Promise.resolve([] as VisitAskProductManager[]),
    canAsk ? loadPlanHolidays(today, visitAskLastDay(today)) : Promise.resolve(new Map<string, string>()),
  ]);
  // Who would be asked, for each kind — only for the person who can ask. Who asks is the viewer himself:
  // the territory's rep, or the Super Admin trying it in test mode.
  const resolved: Array<[VisitAskKind, VisitAskAddresseeResult]> = canAsk
    ? VISIT_ASK_KINDS.map((kind): [VisitAskKind, VisitAskAddresseeResult] => [
        kind,
        resolveVisitAskAddressees({
          org: viewer.org,
          seatId: seat.seatId,
          kind,
          repHrId: viewer.hrId,
          productManagers,
          // A product manager's visit is offered when his line has one; WHICH one is the rep's pick.
          productManagerHrId: productManagers[0]?.hrId ?? null,
        }),
      ])
    : [];
  const names = await loadPeopleNames([
    ...askPeople(rows),
    ...productManagers.map((entry) => entry.hrId),
    ...resolved.flatMap(([, result]) => (result.ok ? [result.value.askedHrId, result.value.toldHrId] : [])),
  ]);
  const asks = rows.map((row) => mapAsk(row, viewer, names)).sort(byWaitingThenNewest);

  const offers: VisitAskOffer[] = resolved.map(([kind, result]) => {
    const open = asks.find((ask) => ask.kind === kind && isVisitAskOpen(ask, today)) ?? null;
    if (!result.ok) return { kind, available: false, reason: result.error, askedName: null, toldName: null, open };
    return {
      kind,
      available: true,
      reason: null,
      askedName: kind === "product_manager" ? null : nameOf(names, result.value.askedHrId),
      toldName: result.value.toldHrId ? nameOf(names, result.value.toldHrId) : null,
      open,
    };
  });

  return {
    isTest,
    customerId,
    canAsk,
    offers,
    productManagers: productManagers
      .map((entry) => ({ hrId: entry.hrId, name: nameOf(names, entry.hrId), title: entry.role }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    wishDays: canAsk ? visitAskDayChoices(today, holidays) : [],
    asks,
  };
}

// ── Raising one ─────────────────────────────────────────────────────────────────────────────────

function addresseeRefusal(result: Extract<VisitAskAddresseeResult, { ok: false }>): ApiError {
  return result.kind === "not_line_product_manager" ? validationError(result.error) : conflictError(result.error);
}

/**
 * POST: the rep asks for a visit with somebody, from the customer's page — one tap and a confirm. Who
 * is asked comes from the organogram and the line's product managers, never from the body: the body
 * names the kind and, for a product manager's visit, which of his line's product managers.
 */
export async function raiseVisitAsk(viewer: PhoenixCrmViewer, raw: unknown): Promise<VisitAskCustomerView> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isVisitAskKind(body.kind)) throw validationError("Choose who the visit is with.");
  const kind = body.kind;
  const customerId = typeof body.customerId === "string" ? body.customerId.trim().toLowerCase() : "";
  if (!isUuid(customerId)) throw validationError("Choose a customer.");

  const productManagers = kind === "product_manager" ? await loadLineProductManagers(seat) : [];
  const resolved = resolveVisitAskAddressees({
    org: viewer.org,
    seatId: seat.seatId,
    kind,
    repHrId: viewer.hrId,
    productManagers,
    productManagerHrId: body.productManagerHrId,
  });
  if (!resolved.ok) throw addresseeRefusal(resolved);

  const result = await callPhoenixCrm<Row>("phoenix_crm_raise_visit_ask", {
    p: {
      seat_id: seat.seatId,
      line_code: seat.lineCode,
      customer_id: customerId,
      kind,
      rep_hr_id: viewer.hrId,
      asked_hr_id: resolved.value.askedHrId,
      told_hr_id: resolved.value.toldHrId,
      // A wish: a day that cannot be a field day to come is dropped here and again in the database.
      wished_on: wishedVisitAskDay(body.wishedOn, viewer.cairoToday),
      visit_id: null,
      is_test: isTest,
    },
  });

  if (result.created === true) {
    await notifyPhoenixCrm(
      {
        kind: "visit_ask",
        seat,
        askId: String(result.id),
        askKind: kind,
        status: "waiting",
        repHrId: viewer.hrId,
        askedHrId: resolved.value.askedHrId,
        toldHrId: resolved.value.toldHrId,
        customerName: textOrNull(result.customer_name) ?? "a customer",
        listType: parseListType(result.customer_list_type),
        wishedOn: textOrNull(result.wished_on),
        visitOn: null,
      },
      isTest,
    );
  }
  return loadVisitAskCustomerView(viewer, { seatId: seat.seatId, customerId, test: isTest });
}

/** What the visit's saved banner says about the ask its next step raised. */
export type VisitAskFromVisit = { askedName: string; created: boolean };

/**
 * The visit next step "Arrange a double visit" raises a DOUBLE ask to the territory's reviewer, by
 * itself, when the rep saves the visit (owner, 2026-10-02 — "nothing reads it today"). The wished day
 * is the step's own date.
 *
 * 🔴 IT NEVER THROWS, AND IT NEVER COSTS THE REP HIS VISIT. The visit is already saved when this runs.
 * A customer waiting outside the list, a territory with nobody above it, an ask already in play or a
 * database hiccup each leave the visit exactly as saved; only a failure nobody expected is logged.
 * Idempotent per visit: the database raises at most one ask per visit id, so a save sent twice — or
 * retried after a dropped connection — asks once and tells the manager once.
 */
export async function raiseVisitAskFromVisit(
  viewer: PhoenixCrmViewer,
  input: { seat: OrgSeat; isTest: boolean; visitId: string; customerId: string; repHrId: string; wishedOn: string | null },
): Promise<VisitAskFromVisit | null> {
  const { seat, isTest } = input;
  try {
    const resolved = resolveVisitAskAddressees({ org: viewer.org, seatId: seat.seatId, kind: "double", repHrId: input.repHrId, productManagers: [] });
    if (!resolved.ok) return null;
    const result = await callPhoenixCrm<Row>("phoenix_crm_raise_visit_ask", {
      p: {
        seat_id: seat.seatId,
        line_code: seat.lineCode,
        customer_id: input.customerId,
        kind: "double",
        rep_hr_id: personKey(input.repHrId),
        asked_hr_id: resolved.value.askedHrId,
        told_hr_id: null,
        wished_on: wishedVisitAskDay(input.wishedOn, viewer.cairoToday),
        visit_id: input.visitId,
        is_test: isTest,
      },
    });
    const created = result.created === true;
    const askedHrId = textOrNull(result.asked_hr_id) ?? resolved.value.askedHrId;
    if (created) {
      await notifyPhoenixCrm(
        {
          kind: "visit_ask",
          seat,
          askId: String(result.id),
          askKind: "double",
          status: "waiting",
          repHrId: personKey(input.repHrId) ?? input.repHrId,
          askedHrId,
          toldHrId: null,
          customerName: textOrNull(result.customer_name) ?? "a customer",
          listType: parseListType(result.customer_list_type),
          wishedOn: textOrNull(result.wished_on),
          visitOn: null,
        },
        isTest,
      );
    }
    const names = await loadPeopleNames([askedHrId]);
    return { askedName: nameOf(names, askedHrId, "your manager"), created };
  } catch (error) {
    // A refusal the module wrote (a customer outside the list) is the expected quiet answer.
    if (!(error instanceof ApiError)) {
      logError("Phoenix CRM could not raise the double visit a visit's next step asked for", {
        error,
        labels: { event: "phoenix_crm_visit_ask_from_visit_failed", visitId: input.visitId },
      });
    }
    return null;
  }
}

/** The line the saved visit's banner shows the rep about the ask his next step raised. */
export function visitAskSavedNote(ask: VisitAskFromVisit | null): string | null {
  if (!ask) return null;
  return ask.created
    ? `${ask.askedName} is asked for a double visit with you to this customer. The answer shows on the customer's page.`
    : `A double visit to this customer is already asked of ${ask.askedName}. The answer shows on the customer's page.`;
}

// ── Taking one back ─────────────────────────────────────────────────────────────────────────────

async function loadAskRow(askId: string): Promise<Row | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visit_asks")
    .select(ASK_COLUMNS)
    .eq("id", askId)
    .maybeSingle();
  throwIfError(error);
  return (data as unknown as Row | null) ?? null;
}

/**
 * POST: the rep takes back an ask still waiting. The territory's own rep, in the ask's own world; an
 * answered ask stays — an accepted visit is the person asked's to keep. Nobody is told: the waiting
 * notices are withdrawn, so the person asked is not left with a to-do that no longer exists.
 */
export async function cancelVisitAsk(viewer: PhoenixCrmViewer, raw: unknown): Promise<VisitAskCustomerView> {
  const body = record(raw);
  const askId = typeof body.askId === "string" ? body.askId.trim().toLowerCase() : "";
  if (!isUuid(askId)) throw validationError("Choose the ask. Reload the page.");
  const row = await loadAskRow(askId);
  if (!row) throw notFoundError("This ask is no longer there. Reload the page.", "phoenix_crm_visit_ask_not_found");
  const rowIsTest = row.is_test === true;
  const { seat, isTest } = territoryForRepWrite(viewer, row.seat_id, rowIsTest);
  // A test login cancels test asks only — never a real one, whatever its own seat.
  if (isTest !== rowIsTest) throw forbiddenError("This is a test login: it works on test entries only. Real entries stay as they are.");

  await callPhoenixCrm<Row>("phoenix_crm_cancel_visit_ask", {
    p: { ask_id: askId, seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest },
  });
  await withdrawPhoenixCrmVisitAskNotices(askId);
  return loadVisitAskCustomerView(viewer, { seatId: seat.seatId, customerId: String(row.customer_id), test: isTest });
}

// ── Answering one ───────────────────────────────────────────────────────────────────────────────

export type VisitAskInboxView = {
  isTest: boolean;
  mode: "own" | "all";
  /** The viewer answers the asks waiting for him. */
  canAnswer: boolean;
  /** Waiting for the viewer's answer, the longest-waiting first. */
  waiting: VisitAskView[];
  /** Everything else he reads: the asks he is told about, the answered and the cancelled, in scope. */
  others: VisitAskView[];
  /** The days he may pick when he accepts: today to four weeks on, never a Friday or a public holiday. */
  dayChoices: string[];
};

/**
 * POST: the person asked accepts with a day, or declines. Identity from the ROW (`assertVisitAskAnswerer`);
 * the day is one of the rep's field days, never a public holiday (checked here — the national calendar
 * lives outside the module) and never in the past or beyond four weeks (checked here and again in the
 * database). The rep is told, and the person told is told again; the "accept or decline" notice goes.
 */
export async function answerVisitAsk(viewer: PhoenixCrmViewer, raw: unknown): Promise<VisitAskInboxView> {
  const body = record(raw);
  const askId = typeof body.askId === "string" ? body.askId.trim().toLowerCase() : "";
  if (!isUuid(askId)) throw validationError("Choose the ask. Reload the page.");
  const decision = body.decision === "accept" ? "accept" : body.decision === "decline" ? "decline" : null;
  if (!decision) throw validationError("Choose accept or decline.");

  const row = await loadAskRow(askId);
  if (!row) throw notFoundError("This ask is no longer there. Reload the page.", "phoenix_crm_visit_ask_not_found");
  const isTest = row.is_test === true;
  const status: VisitAskStatus = isVisitAskStatus(row.status) ? row.status : "waiting";
  assertVisitAskAnswerer(viewer, { askedHrId: String(row.asked_hr_id ?? ""), isTest, status });

  let visitOn: string | null = null;
  if (decision === "accept") {
    // The day's own month only: a public holiday holds no visit (server/plan-holidays.ts).
    const holidays = isIsoDay(body.day) ? await loadPlanHolidays(body.day, body.day) : new Map<string, string>();
    const day = resolveVisitAskDay({ day: body.day, cairoToday: viewer.cairoToday, holidays });
    if (!day.ok) throw day.kind === "bad_input" || day.kind === "not_field_day" ? validationError(day.error) : conflictError(day.error);
    visitOn = day.day;
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_answer_visit_ask", {
    p: { ask_id: askId, actor_hr_id: viewer.hrId, decision, visit_on: visitOn, is_test: isTest },
  });
  // The "accept or decline" line has done its job (the off-plan visit's notice follows the same rule).
  await withdrawPhoenixCrmVisitAskNotices(askId, "waiting");

  const seat = viewer.org.seats.get(String(row.seat_id));
  const kind: VisitAskKind = isVisitAskKind(row.kind) ? row.kind : "double";
  const customer = record(Array.isArray(row.customer) ? row.customer[0] : row.customer);
  const answered = result.status === "accepted" ? "accepted" : "declined";
  if (seat) {
    await notifyPhoenixCrm(
      {
        kind: "visit_ask",
        seat,
        askId,
        askKind: kind,
        status: answered,
        repHrId: String(row.rep_hr_id),
        askedHrId: String(row.asked_hr_id),
        toldHrId: textOrNull(row.told_hr_id),
        customerName: textOrNull(result.customer_name) ?? textOrNull(customer.name) ?? "the customer",
        listType: parseListType(customer.list_type),
        wishedOn: textOrNull(row.wished_on),
        visitOn: textOrNull(result.visit_on),
      },
      isTest,
    );
  }
  return loadVisitAskInbox(viewer, { test: isTest });
}

// ── The inbox ───────────────────────────────────────────────────────────────────────────────────

/**
 * Asks that still wait, or that moved in the last 30 days — an ask accepted for a day still to come
 * always has (the day is at most four weeks after the answer). A date, never an instant: the filter is
 * one PostgREST `or`, and a date carries no character it would have to quote.
 */
function recentFilter(since: string): string {
  return `status.eq.waiting,updated_at.gte.${since}`;
}

/** The asks addressed or told to one person, in one world. Two reads, one per place he can stand. */
async function loadOwnAskRows(hrId: string, isTest: boolean, since: string): Promise<Row[]> {
  const read = (column: "asked_hr_id" | "told_hr_id") =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_visit_asks")
          .select(ASK_COLUMNS)
          .eq(column, hrId)
          .eq("is_test", isTest)
          .or(recentFilter(since)),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  const [asked, told] = await Promise.all([read("asked_hr_id"), read("told_hr_id")]);
  const byId = new Map<string, Row>();
  for (const row of [...asked, ...told]) byId.set(String(row.id), row);
  return [...byId.values()];
}

/** Every ask on these territories in one world — or, for the Super Admin's test mode, every test ask. */
async function loadScopeAskRows(seatIds: ReadonlyArray<string> | null, isTest: boolean, since: string): Promise<Row[]> {
  if (seatIds === null) {
    return fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_visit_asks").select(ASK_COLUMNS).eq("is_test", isTest).or(recentFilter(since)),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  }
  const rows: Row[] = [];
  for (const part of chunk([...seatIds], 100)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_visit_asks")
            .select(ASK_COLUMNS)
            .in("seat_id", part)
            .eq("is_test", isTest)
            .or(recentFilter(since)),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

/** GET: the asks the viewer answers or reads — the district manager's "Asked by your reps", a product manager's "Visit asks". */
export async function loadVisitAskInbox(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<VisitAskInboxView> {
  const isTest = testModeFor(viewer, raw.test);
  const reach = visitAskInboxReach(viewer, isTest);
  if (!reach) throw forbiddenError("Visit asks are for the managers and product managers they are addressed to, SFE and the Super Admin.");
  const today = viewer.cairoToday;
  const since = addDaysIso(today, -INBOX_DAYS);

  let rows: Row[];
  if (reach.mode === "own") {
    rows = await loadOwnAskRows(viewer.hrId, isTest, since);
  } else if (viewer.isSuperAdmin && isTest) {
    rows = await loadScopeAskRows(null, true, since);
  } else {
    rows = await loadScopeAskRows(testReadSeats(viewer, isTest, viewer.scopeTerritories).map((seat) => seat.seatId), isTest, since);
  }

  const names = await loadPeopleNames(askPeople(rows));
  const asks = rows.map((row) => mapAsk(row, viewer, names));
  const waiting = asks.filter((ask) => ask.canAnswer).sort((left, right) => left.raisedAt.localeCompare(right.raisedAt));
  const others = asks.filter((ask) => !ask.canAnswer).sort(byWaitingThenNewest);
  const holidays = waiting.length > 0 ? await loadPlanHolidays(today, visitAskLastDay(today)) : new Map<string, string>();
  return {
    isTest,
    mode: reach.mode,
    canAnswer: reach.canAnswer,
    waiting,
    others,
    dayChoices: waiting.length > 0 ? visitAskDayChoices(today, holidays) : [],
  };
}

/**
 * The Team tab's and the overview's figures: how the viewer reads asks, whether there is anything for
 * him to read at all, and how many wait for his answer.
 */
export type VisitAskSummary = VisitAskInboxReach & { waitingForYou: number; anyToRead: boolean };

/** One head count of asks in one world: one person's place on them, waiting ones only, or recent ones. */
async function countAsks(
  isTest: boolean,
  filter: { person: { column: "asked_hr_id" | "told_hr_id"; hrId: string } | null; waitingOnly: boolean; since: string | null },
): Promise<number> {
  let query = getSupabaseAdmin().from("phoenix_crm_visit_asks").select("id", { count: "exact", head: true }).eq("is_test", isTest);
  if (filter.person) query = query.eq(filter.person.column, filter.person.hrId);
  if (filter.waitingOnly) query = query.eq("status", "waiting");
  if (filter.since) query = query.or(recentFilter(filter.since));
  const { count, error } = await query;
  throwIfError(error);
  return count ?? 0;
}

/**
 * How many asks wait for this viewer's answer in `isTest`'s world — the count behind "waiting for you".
 * One head count, never a row: the Super Admin's test count is every waiting test ask (he answers them
 * all there); a person's own is the asks recorded as his. SFE reads every real ask and answers none, so
 * nothing waits for SFE — and nothing waits for anyone the inbox refuses, who is never counted at all.
 */
export async function countVisitAsksWaitingForYou(viewer: PhoenixCrmViewer, isTest: boolean): Promise<number> {
  const reach = visitAskInboxReach(viewer, isTest);
  if (!reach || !reach.canAnswer) return 0;
  const person = reach.mode === "all" ? null : { column: "asked_hr_id" as const, hrId: viewer.hrId };
  return countAsks(isTest, { person, waitingOnly: true, since: null });
}

/**
 * The Team tab's figures: how many asks wait for this viewer's answer, and whether he has any ask to
 * read. Null for everyone the inbox refuses. Counts only, never a row.
 */
export async function loadVisitAskSummary(viewer: PhoenixCrmViewer, isTest: boolean): Promise<VisitAskSummary | null> {
  const reach = visitAskInboxReach(viewer, isTest);
  if (!reach) return null;
  if (reach.mode === "all") return { ...reach, waitingForYou: await countVisitAsksWaitingForYou(viewer, isTest), anyToRead: true };
  const since = addDaysIso(viewer.cairoToday, -INBOX_DAYS);
  const [waitingForYou, asked, told] = await Promise.all([
    countVisitAsksWaitingForYou(viewer, isTest),
    countAsks(isTest, { person: { column: "asked_hr_id", hrId: viewer.hrId }, waitingOnly: false, since }),
    countAsks(isTest, { person: { column: "told_hr_id", hrId: viewer.hrId }, waitingOnly: false, since }),
  ]);
  return { ...reach, waitingForYou, anyToRead: asked + told > 0 };
}
