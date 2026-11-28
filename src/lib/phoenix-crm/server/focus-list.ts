/**
 * Phoenix CRM — the Focus list (owner, 2026-11-28). The rules are in `@/lib/phoenix-crm/focus-list-rules`; this
 * file reads and writes `phoenix_crm_focus_customers` (20261128135234) behind the module's territory gates.
 *
 *   - THE REP reads his own territory's Focus list — grouped by grade, then brick — with the reason and where
 *     each customer stands. 🔴 No visit count, no last visit, no name of who judged it (Golden rule #1).
 *   - A MANAGER of the territory reads the same list with the TRACKING: the visits inside a From–To period he
 *     chooses, per field week, the weekly average, and the latest visit ever (when, where, by whom). He picks
 *     one rep's territory or all of his.
 *   - Either of them PUSHES a PM customer of the territory with a written reason (required) and a pick
 *     (optional). A rep's push waits for the manager's Keep or Return; a manager's own push is kept at once.
 *   - The REP or a MANAGER returns a customer to the normal list. The row stays as history.
 *
 * Focus is a MARK: the customer never leaves the territory's list, so plans, visits and every KPI read as before.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  focusPeriodWeeks,
  focusReasonPickLabel,
  focusStandingText,
  focusVisitKindLabel,
  focusWeekCounts,
  focusWeeklyAverage,
  readFocusPeriod,
  readFocusReason,
  readFocusReasonPick,
  type FocusCandidate,
  type FocusEntry,
  type FocusListView,
  type FocusPeriod,
  type FocusReviewStatus,
} from "@/lib/phoenix-crm/focus-list-rules";
import { seatOccupants, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  canDecideFocus,
  canPushFocus,
  canReturnOwnFocus,
  territoryForFocusPush,
  territoryForView,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPlannerReferences } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm, withdrawPhoenixCrmFocusWaitingNotice } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const FOCUS_COLUMNS =
  "id, seat_id, customer_id, reason, reason_pick, pushed_by_hr_id, pushed_as, pushed_at, review_status, reviewed_by_hr_id, reviewed_at, is_test";

/** A customer on the list a PM customer can be pushed from: validated, or carried over and waiting to be. */
const PUSHABLE_STATUSES = ["active", "pending"] as const;

function isOwn(viewer: PhoenixCrmViewer, seatId: string): boolean {
  return viewer.ownTerritories.some((entry) => entry.seatId === seatId);
}

/** The territories a manager's tracking picks from: every one in his scope he does not hold as the rep. */
function managedTerritories(viewer: PhoenixCrmViewer): OrgSeat[] {
  return viewer.scopeTerritories.filter((seat) => !isOwn(viewer, seat.seatId));
}

async function readOpenRows(seatIds: string[], isTest: boolean): Promise<Row[]> {
  if (seatIds.length === 0) return [];
  const rows: Row[] = [];
  for (const ids of chunk(seatIds, 200)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_focus_customers")
            .select(FOCUS_COLUMNS)
            .in("seat_id", ids)
            .eq("is_test", isTest)
            .is("returned_at", null),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

async function readCustomers(customerIds: string[]): Promise<Map<string, Row>> {
  const byId = new Map<string, Row>();
  for (const ids of chunk(customerIds, 200)) {
    const read = await getSupabaseAdmin()
      .from("phoenix_crm_customers")
      .select("id, seat_id, name, speciality, grade, status, list_type, reference_contact_crm_id")
      .in("id", ids);
    throwIfError(read.error);
    for (const row of (read.data ?? []) as Row[]) byId.set(String(row.id), row);
  }
  return byId;
}

/** The brick of each customer: his active place's, else (carried over, no place yet) the reference's. */
async function readBricks(customers: Row[], isTest: boolean): Promise<Map<string, string>> {
  const bricks = new Map<string, string>();
  const ids = customers.map((row) => String(row.id));
  for (const part of chunk(ids, 200)) {
    const read = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("customer_id, brick_name, captured_at")
      .in("customer_id", part)
      .eq("is_test", isTest)
      .eq("status", "active")
      .order("captured_at", { ascending: false, nullsFirst: false });
    throwIfError(read.error);
    for (const row of (read.data ?? []) as Row[]) {
      const brick = textOrNull(row.brick_name);
      const id = String(row.customer_id);
      if (brick && !bricks.has(id)) bricks.set(id, brick);
    }
  }
  const pendingBySeat = new Map<string, Row[]>();
  for (const row of customers) {
    if (bricks.has(String(row.id)) || row.status !== "pending") continue;
    const seatId = String(row.seat_id);
    pendingBySeat.set(seatId, [...(pendingBySeat.get(seatId) ?? []), row]);
  }
  for (const [seatId, rows] of pendingBySeat) {
    const references = await loadPlannerReferences(seatId, isTest, rows);
    for (const [customerId, reference] of references) if (reference.brick) bricks.set(customerId, reference.brick);
  }
  return bricks;
}

type FocusVisitsAnswer = {
  period?: Array<{ customer_id: string; visit_date: string }>;
  latest?: Array<{
    customer_id: string;
    visit_date: string;
    captured_at: string | null;
    kind: string | null;
    rep_hr_id: string | null;
    manager_hr_id: string | null;
    imported: boolean | null;
    place_label: string | null;
    place_address: string | null;
    brick_name: string | null;
  }>;
};

async function readVisits(customerIds: string[], isTest: boolean, period: FocusPeriod): Promise<Required<FocusVisitsAnswer>> {
  const answer: Required<FocusVisitsAnswer> = { period: [], latest: [] };
  for (const ids of chunk(customerIds, 200)) {
    const read = await getSupabaseAdmin().rpc("phoenix_crm_focus_visits", {
      p_customer_ids: ids,
      p_is_test: isTest,
      p_from: period.from,
      p_to: period.to,
    });
    throwIfError(read.error);
    const data = (read.data ?? {}) as FocusVisitsAnswer;
    answer.period.push(...(data.period ?? []));
    answer.latest.push(...(data.latest ?? []));
  }
  return answer;
}

/**
 * The Focus list one viewer reads. A rep reads his own territory; a manager one territory he picks, or "all" of
 * his, with the tracking over `from`–`to`.
 */
export async function loadFocusList(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; from: unknown; to: unknown },
): Promise<FocusListView> {
  const today = viewer.visitDay;
  const asked = typeof raw.seatId === "string" ? raw.seatId.trim() : "";
  const managed = managedTerritories(viewer);
  const repMode = (asked === "" && managed.length === 0) || (asked !== "" && asked !== "all" && isOwn(viewer, asked));

  let seats: OrgSeat[];
  let isTest: boolean;
  let selected: string;
  if (repMode) {
    const access = territoryForView(viewer, asked || viewer.ownTerritories[0]?.seatId, false);
    seats = [access.seat];
    isTest = access.isTest;
    selected = access.seat.seatId;
  } else if (asked !== "" && asked !== "all") {
    const access = territoryForView(viewer, asked, false);
    seats = [access.seat];
    isTest = viewer.isTestPersona;
    selected = access.seat.seatId;
  } else {
    if (managed.length === 0) throw forbiddenError("There is no team in your scope to track.");
    seats = managed;
    isTest = viewer.isTestPersona;
    selected = "all";
  }

  const seatById = new Map(seats.map((seat) => [seat.seatId, seat]));
  const rows = await readOpenRows([...seatById.keys()], isTest);
  const customers = await readCustomers([...new Set(rows.map((row) => String(row.customer_id)))]);
  const bricks = await readBricks([...customers.values()], isTest);
  const period = repMode ? null : readFocusPeriod(raw.from, raw.to, today);
  const visits = period && rows.length > 0 ? await readVisits([...customers.keys()], isTest, period) : { period: [], latest: [] };

  const peopleIds = new Set<string>();
  for (const seat of seats) for (const hrId of seatOccupants(seat)) peopleIds.add(hrId);
  if (!repMode) {
    for (const row of rows) peopleIds.add(String(row.pushed_by_hr_id));
    for (const visit of visits.latest) {
      if (visit.rep_hr_id) peopleIds.add(visit.rep_hr_id);
      if (visit.manager_hr_id) peopleIds.add(visit.manager_hr_id);
    }
  }
  const names = await loadPeopleNames(peopleIds);
  const repNamesOf = (seat: OrgSeat) => seatOccupants(seat).map((hrId) => nameOf(names, hrId, hrId));

  const daysByCustomer = new Map<string, string[]>();
  for (const visit of visits.period) daysByCustomer.set(visit.customer_id, [...(daysByCustomer.get(visit.customer_id) ?? []), visit.visit_date]);
  const latestByCustomer = new Map(visits.latest.map((visit) => [visit.customer_id, visit]));

  const entries: FocusEntry[] = [];
  for (const row of rows) {
    const seat = seatById.get(String(row.seat_id));
    const customer = customers.get(String(row.customer_id));
    if (!seat || !customer) continue;
    const customerId = String(customer.id);
    const reviewStatus: FocusReviewStatus = row.review_status === "kept" ? "kept" : "waiting";
    const pushedAs = row.pushed_as === "manager" ? "manager" : "rep";
    const decides = canDecideFocus(viewer, seat, isTest);
    const entry: FocusEntry = {
      id: String(row.id),
      seatId: seat.seatId,
      territoryName: territoryName(seat),
      customerId,
      customerName: textOrNull(customer.name) ?? "Unnamed customer",
      speciality: textOrNull(customer.speciality),
      grade: textOrNull(customer.grade),
      brick: bricks.get(customerId) ?? null,
      reason: textOrNull(row.reason) ?? "",
      reasonPickLabel: focusReasonPickLabel(textOrNull(row.reason_pick)),
      pushedAs,
      pushedAt: String(row.pushed_at),
      reviewStatus,
      standing: focusStandingText(reviewStatus, pushedAs),
      canKeep: !repMode && decides && reviewStatus === "waiting",
      canReturn: repMode ? canReturnOwnFocus(viewer, seat, isTest) : decides,
    };
    if (!repMode && period) {
      const days = daysByCustomer.get(customerId) ?? [];
      const latest = latestByCustomer.get(customerId);
      entry.repNames = repNamesOf(seat);
      entry.pushedByName = nameOf(names, String(row.pushed_by_hr_id), "A rep");
      entry.tracking = {
        visits: days.length,
        weeks: focusWeekCounts(days, period),
        weeklyAverage: focusWeeklyAverage(days.length, period),
        last: latest
          ? {
              day: latest.visit_date,
              savedAt: latest.imported ? null : latest.captured_at,
              kind: focusVisitKindLabel(latest.kind),
              by: [latest.rep_hr_id, latest.manager_hr_id]
                .filter((hrId): hrId is string => Boolean(hrId))
                .map((hrId) => nameOf(names, hrId, hrId))
                .join(" with "),
              place: latest.place_label,
              address: latest.place_address,
              brick: latest.brick_name,
              imported: latest.imported === true,
            }
          : null,
      };
    }
    entries.push(entry);
  }

  const selectedSeat = selected === "all" ? null : seatById.get(selected) ?? null;
  return {
    mode: repMode ? "rep" : "manager",
    isTest,
    today,
    selected,
    territories: (repMode ? seats : managed).map((seat) => ({ seatId: seat.seatId, name: territoryName(seat), repNames: repNamesOf(seat) })),
    canPush: selectedSeat ? canPushFocus(viewer, selectedSeat, isTest) : false,
    period,
    weeks: period ? focusPeriodWeeks(period) : [],
    entries,
    waiting: entries.filter((entry) => entry.reviewStatus === "waiting").length,
  };
}

/** The territory's PM customers not on its Focus list yet — what "Add a PM customer" picks from. */
export async function loadFocusCandidates(viewer: PhoenixCrmViewer, raw: { seatId: unknown }): Promise<FocusCandidate[]> {
  const { seat, isTest } = territoryForFocusPush(viewer, raw.seatId);
  const [customers, open] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_customers")
          .select("id, seat_id, name, speciality, grade, status, reference_contact_crm_id")
          .eq("seat_id", seat.seatId)
          .eq("is_test", isTest)
          .eq("list_type", "PM")
          .eq("campaign_visit_holder", false)
          .in("status", [...PUSHABLE_STATUSES]),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    readOpenRows([seat.seatId], isTest),
  ]);
  const onFocus = new Set(open.map((row) => String(row.customer_id)));
  const left = customers.filter((row) => !onFocus.has(String(row.id)));
  const bricks = await readBricks(left, isTest);
  return left
    .map((row) => ({
      customerId: String(row.id),
      name: textOrNull(row.name) ?? "Unnamed customer",
      speciality: textOrNull(row.speciality),
      grade: textOrNull(row.grade),
      brick: bricks.get(String(row.id)) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bodyOf(raw: unknown): Row {
  return raw && typeof raw === "object" ? (raw as Row) : {};
}

async function readOpenRow(focusId: unknown): Promise<Row> {
  if (typeof focusId !== "string" || focusId.trim() === "") throw validationError("Pick a customer on the Focus list.");
  const read = await getSupabaseAdmin()
    .from("phoenix_crm_focus_customers")
    .select(`${FOCUS_COLUMNS}, returned_at, customer:phoenix_crm_customers!customer_id(name)`)
    .eq("id", focusId.trim())
    .maybeSingle();
  throwIfError(read.error);
  const row = read.data as Row | null;
  if (!row) throw notFoundError("This customer is not on the Focus list any more. Reload the page.");
  return row;
}

function customerNameOf(row: Row): string {
  const embedded = Array.isArray(row.customer) ? row.customer[0] : row.customer;
  return (embedded && typeof embedded === "object" ? textOrNull((embedded as Row).name) : null) ?? "A PM customer";
}

/** Put a PM customer of the territory on its Focus list. */
export async function pushFocusCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ focusId: string }> {
  const body = bodyOf(raw);
  const { seat, isTest, pushedAs } = territoryForFocusPush(viewer, body.seatId);
  const reason = readFocusReason(body.reason);
  if (!reason.ok) throw validationError(reason.message);
  const pick = readFocusReasonPick(body.reasonPick);
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  if (!customerId) throw validationError("Pick the PM customer to put on the Focus list.");

  const read = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, seat_id, name, status, list_type, is_test")
    .eq("id", customerId)
    .maybeSingle();
  throwIfError(read.error);
  const customer = read.data as Row | null;
  if (!customer || customer.seat_id !== seat.seatId || customer.is_test !== isTest) {
    throw notFoundError("This customer is not on this territory's list. Reload the page.");
  }
  if (customer.list_type !== "PM") throw validationError("Only a PM customer goes on the Focus list.");
  if (!PUSHABLE_STATUSES.includes(customer.status as (typeof PUSHABLE_STATUSES)[number])) {
    throw validationError("Only a customer on the territory's list goes on the Focus list.");
  }

  const now = new Date().toISOString();
  const insert = await getSupabaseAdmin()
    .from("phoenix_crm_focus_customers")
    .insert({
      seat_id: seat.seatId,
      line_code: seat.lineCode,
      customer_id: customerId,
      reason: reason.reason,
      reason_pick: pick,
      pushed_by_hr_id: viewer.hrId,
      pushed_as: pushedAs,
      pushed_at: now,
      // A manager's own push is his decision already: kept at once.
      review_status: pushedAs === "manager" ? "kept" : "waiting",
      reviewed_by_hr_id: pushedAs === "manager" ? viewer.hrId : null,
      reviewed_at: pushedAs === "manager" ? now : null,
      is_test: isTest,
    })
    .select("id")
    .single();
  if (insert.error && (insert.error as { code?: string }).code === "23505") {
    throw conflictError("This customer is already on the Focus list.");
  }
  throwIfError(insert.error);
  const focusId = String((insert.data as Row).id);
  await notifyPhoenixCrm(
    {
      kind: "focus_list",
      step: "pushed",
      org: viewer.org,
      seat,
      focusId,
      customerName: textOrNull(customer.name) ?? "A PM customer",
      actorHrId: viewer.hrId,
      actedAs: pushedAs,
      note: reason.reason,
    },
    isTest,
  );
  return { focusId };
}

/** The manager keeps a rep's push on the Focus list. */
export async function keepFocusCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ focusId: string }> {
  const body = bodyOf(raw);
  const row = await readOpenRow(body.focusId);
  if (row.returned_at) throw conflictError("This customer is back on the normal list already. Reload the page.");
  const seat = viewer.org.seats.get(String(row.seat_id));
  const isTest = row.is_test === true;
  if (!seat || !canDecideFocus(viewer, seat, isTest)) throw forbiddenError("Only a manager of the territory keeps a Focus list push.");
  if (row.review_status === "kept") return { focusId: String(row.id) };
  const now = new Date().toISOString();
  const update = await getSupabaseAdmin()
    .from("phoenix_crm_focus_customers")
    .update({ review_status: "kept", reviewed_by_hr_id: viewer.hrId, reviewed_at: now, updated_at: now })
    .eq("id", String(row.id))
    .is("returned_at", null)
    .eq("review_status", "waiting")
    .select("id");
  throwIfError(update.error);
  if ((update.data ?? []).length === 0) throw conflictError("This Focus list entry changed a moment ago. Reload the page.");
  await withdrawPhoenixCrmFocusWaitingNotice(String(row.id));
  await notifyPhoenixCrm(
    {
      kind: "focus_list",
      step: "kept",
      org: viewer.org,
      seat,
      focusId: String(row.id),
      customerName: customerNameOf(row),
      actorHrId: viewer.hrId,
      actedAs: "manager",
      note: null,
    },
    isTest,
  );
  return { focusId: String(row.id) };
}

/** The rep or a manager returns a customer from the Focus list to the normal list. */
export async function returnFocusCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ focusId: string }> {
  const body = bodyOf(raw);
  const row = await readOpenRow(body.focusId);
  if (row.returned_at) return { focusId: String(row.id) };
  const seat = viewer.org.seats.get(String(row.seat_id));
  const isTest = row.is_test === true;
  if (!seat) throw notFoundError("This territory is not in the organogram. Reload the page.");
  const actedAs = canDecideFocus(viewer, seat, isTest) ? "manager" : canReturnOwnFocus(viewer, seat, isTest) ? "rep" : null;
  if (!actedAs) throw forbiddenError("Only the territory's rep or one of its managers returns a customer to the normal list.");
  const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim().slice(0, 500) || null : null;
  const now = new Date().toISOString();
  const update = await getSupabaseAdmin()
    .from("phoenix_crm_focus_customers")
    .update({ returned_at: now, returned_by_hr_id: viewer.hrId, returned_as: actedAs, return_note: note, updated_at: now })
    .eq("id", String(row.id))
    .is("returned_at", null)
    .select("id");
  throwIfError(update.error);
  if ((update.data ?? []).length === 0) return { focusId: String(row.id) };
  await withdrawPhoenixCrmFocusWaitingNotice(String(row.id));
  await notifyPhoenixCrm(
    {
      kind: "focus_list",
      step: "returned",
      org: viewer.org,
      seat,
      focusId: String(row.id),
      customerName: customerNameOf(row),
      actorHrId: viewer.hrId,
      actedAs,
      note,
    },
    isTest,
  );
  return { focusId: String(row.id) };
}

/** The one POST: `action` says which of the three. */
export async function changeFocusList(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ focusId: string }> {
  const action = bodyOf(raw).action;
  if (action === "push") return pushFocusCustomer(viewer, raw);
  if (action === "keep") return keepFocusCustomer(viewer, raw);
  if (action === "return") return returnFocusCustomer(viewer, raw);
  throw validationError("Unknown Focus list action.");
}
