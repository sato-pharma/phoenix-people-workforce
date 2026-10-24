/**
 * Phoenix CRM — the Super Admin enters a record a MANAGER missed: a single visit of his own, or how his day
 * was spent (owner, 2026-10-24, asked which: "Visits and days").
 *
 * The rep's twin is `missed-records.ts`; this is the same rule on a manager's day page. It ADDS what is
 * missing and never rewrites what the manager recorded: a customer he already saw that day cannot be entered
 * again (the table's own unique index), and a day he recorded himself stays his.
 *
 * 🔴 WHO HE IS IS THE MANAGER DAY PAGE'S OWN ANSWER — `resolveManagerDaySubject`, the very gate that decides
 *    whether the page opens — so the Super Admin enters a record only for a manager the calendar draws a row
 *    for. The Super Admin alone (`canEnterMissedRecords`), real data only: a manager's row is never drawn in
 *    test mode.
 *
 * 🔴 A VISIT ENTERED HERE HAS NO LOCATION and is marked "Entered by the Super Admin" — read from
 *    `entered_by_hr_id` differing from the manager (`isManagerVisitEnteredForHim`), since this table has no
 *    `capture_source`. Planned or unplanned is read from HIS plan, never chosen: a manager's unplanned single
 *    visit asks nobody's approval, so it is a fact to file, not a decision. It is NOT held to the district
 *    manager's weekly single-visit limit — that limit stops him logging a fifth half-day, and this records one
 *    that happened — but it counts in his week from then on, exactly as one he logged would.
 *
 * 🔴 A VACANT AREA'S DOCTOR STILL NEEDS THE ADDRESS (owner, 2026-10-19): with no location, the typed address is
 *    the only record of where he is (`vacantVisitPlaceError`, and the table's own CHECK).
 *
 * 🔴 A DAY is filed on the manager's OWN seat (owner, 2026-10-20: a district or regional manager records his own
 *    day there, never on a rep's) — the district and regional tiers alone (`recordsOwnDayOn`); a national sales
 *    manager and a product manager record no day, so only a visit is offered for them.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { cairoOffsetMinutes } from "@/lib/format/cairo-zone";
import { singleVisitHalfOfHour, vacantVisitPlaceError } from "@/lib/phoenix-crm/manager-plan-rules";
import { isMissedRecordDay, missedVisitInstant, parseMissedActivity, parseMissedManagerVisit } from "@/lib/phoenix-crm/missed-records";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canEnterMissedRecords, recordsOwnDayOn, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayActivityOn, mapDayActivityRow, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { callPhoenixCrm, textOrNull } from "@/lib/phoenix-crm/server/db";
import { resolveManagerDaySubject, type ManagerDaySubject } from "@/lib/phoenix-crm/server/manager-day-detail";
import { isVacantTerritory, loadManagerCustomerRow, loadManagerCustomers } from "@/lib/phoenix-crm/server/manager-customers";
import { managerPlanWriterFor } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { loadManagerSlotCustomers, loadManagerSlotRows } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { managerWriterReach } from "@/lib/phoenix-crm/server/manager-plan-writers";
import { loadManagerVisits, writerProductNames } from "@/lib/phoenix-crm/server/manager-visits";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import type { ManagerPlanWriter } from "@/lib/phoenix-crm/manager-plan-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

/** One list the Super Admin picks the customer from: Manager's own list, or one territory he reaches. */
export type ManagerMissedRecordList = { key: string; name: string; note: string | null; vacant: boolean };

export type ManagerMissedRecordCustomer = {
  customerId: string | null;
  managerCustomerId: string | null;
  name: string;
  speciality: string | null;
  /** On a single-visit half-day of HIS plan for that day: the visit files as planned, on that half. */
  planned: boolean;
  /** He already has a visit to this customer that day — one a customer a day. */
  visited: boolean;
  /** The customer's territory has no rep: the visit needs the doctor's address typed. */
  vacant: boolean;
  /** The address already on file for a customer of his own list. */
  knownAddress: string | null;
};

export type ManagerMissedRecordForm = {
  managerKey: string;
  managerName: string;
  date: string;
  through: string;
  /** Manager's own list first, then every territory he reaches, by name. */
  lists: ManagerMissedRecordList[];
  /** The list asked for, and its customers — planned that day first; empty until a list is chosen. */
  list: string | null;
  customers: ManagerMissedRecordCustomer[];
  /** His line's products — optional on every manager visit. */
  products: string[];
  /** A district or regional manager records his own day; a national sales manager and a product manager do not. */
  canRecordDay: boolean;
  dayActivity: DayActivityRow | null;
  /** He recorded that day himself, so it stays his record. */
  activityIsOwn: boolean;
  /** Why nothing can be entered for him, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
};

const OWN_LIST = "own";

type MissedManager = { subject: ManagerDaySubject; writer: ManagerPlanWriter; daySeat: OrgSeat | null };

/** The manager a missed record is entered FOR, by the day page's own gate — or a refusal in words. */
async function missedManager(viewer: PhoenixCrmViewer, rawKey: unknown): Promise<MissedManager> {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin enters a record a manager missed.");
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) throw validationError("Choose a manager.");
  const subject = await resolveManagerDaySubject(viewer, key);
  if (!subject) throw notFoundError("This manager is not on the calendar any more. Reload the page.");
  const writer = managerPlanWriterFor(viewer, subject.hrId);
  if (!writer) throw forbiddenError("This person no longer plans as a manager, so there is nothing to enter for them.");
  // A real record needs one of his lines to be open — before that he has no Phoenix CRM to have missed.
  if (!writer.lineCodes.some((code) => viewer.openLines.has(code))) {
    throw forbiddenError("This manager's line has not started on Phoenix CRM, so there is nothing to enter yet.");
  }
  const seat = subject.productManager ? null : (viewer.org.seats.get(subject.seatId) ?? null);
  const daySeat = seat && recordsOwnDayOn(seat) && personKey(seat.occupantHrId) === subject.hrId ? seat : null;
  return { subject, writer, daySeat };
}

/** The single-visit half-days of HIS plan on that day, by the customer each holds. */
async function plannedSlotsOn(managerHrId: string, date: string): Promise<Map<string, { slotId: string; half: "AM" | "PM" }>> {
  const out = new Map<string, { slotId: string; half: "AM" | "PM" }>();
  const plans = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_plans").select("id").eq("manager_hr_id", managerHrId).eq("week_start", fieldWeekStart(date)).eq("is_test", false),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  if (plans.length === 0) return out;
  const slots = (await loadManagerSlotRows(plans.map((plan) => String(plan.id)))).filter((slot) => slot.date === date && slot.kind === "single_visit");
  if (slots.length === 0) return out;
  const halfOf = new Map(slots.map((slot) => [slot.slotId, slot.half]));
  for (const held of await loadManagerSlotCustomers(slots.map((slot) => slot.slotId))) {
    if (held.gone) continue;
    const key = held.customerId ? `c:${held.customerId}` : held.managerCustomerId ? `m:${held.managerCustomerId}` : null;
    const half = halfOf.get(held.slotId);
    if (key && half && !out.has(key)) out.set(key, { slotId: held.slotId, half });
  }
  return out;
}

/** The rep customers of one territory he reaches, on the list today. */
async function territoryCustomers(seatId: string): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, name, speciality, seat_id, status")
        .eq("seat_id", seatId)
        .eq("is_test", false)
        .in("status", ["active", "pending"]),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

/** GET: what can be entered for one manager on one day — and, once a list is chosen, its customers. */
export async function loadManagerMissedRecordForm(
  viewer: PhoenixCrmViewer,
  raw: { manager: unknown; date: unknown; list?: unknown },
): Promise<ManagerMissedRecordForm> {
  const { subject, writer, daySeat } = await missedManager(viewer, raw.manager);
  if (!isMissedRecordDay(raw.date, viewer.visitDay)) throw validationError("Choose today or an earlier day.");
  const date = raw.date;

  const reach = await managerWriterReach(viewer, writer);
  const [names, products, activity] = await Promise.all([
    loadPeopleNames([subject.hrId, ...reach.map((seat) => seat.occupantHrId)]),
    writerProductNames(viewer, writer),
    daySeat ? loadDayActivityOn(daySeat.seatId, false, date) : Promise.resolve(null),
  ]);

  const lists: ManagerMissedRecordList[] = [
    { key: OWN_LIST, name: "Manager's own list", note: null, vacant: false },
    ...reach
      .map((seat) => {
        const occupant = personKey(seat.occupantHrId);
        return { key: seat.seatId, name: territoryName(seat), note: occupant ? nameOf(names, occupant) : "Vacant", vacant: !occupant };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
  ];

  const asked = typeof raw.list === "string" && lists.some((entry) => entry.key === raw.list) ? raw.list : null;
  let customers: ManagerMissedRecordCustomer[] = [];
  if (asked) {
    const [slots, visits] = await Promise.all([plannedSlotsOn(subject.hrId, date), loadManagerVisits([subject.hrId], { from: date, to: date }, false)]);
    const visited = new Set(visits.map((visit) => (visit.customerId ? `c:${visit.customerId}` : `m:${visit.managerCustomerId}`)));
    if (asked === OWN_LIST) {
      customers = (await loadManagerCustomers(subject.hrId, false))
        .filter((customer) => customer.status === "active")
        .map((customer) => ({
          customerId: null,
          managerCustomerId: customer.id,
          name: customer.name,
          speciality: customer.speciality,
          planned: slots.has(`m:${customer.id}`),
          visited: visited.has(`m:${customer.id}`),
          vacant: isVacantTerritory(viewer.org.seats.get(customer.areaSeatId ?? "")),
          knownAddress: customer.address,
        }));
    } else {
      const vacant = isVacantTerritory(viewer.org.seats.get(asked));
      customers = (await territoryCustomers(asked)).map((row) => {
        const id = String(row.id);
        return {
          customerId: id,
          managerCustomerId: null,
          name: textOrNull(row.name) ?? "Customer",
          speciality: textOrNull(row.speciality),
          planned: slots.has(`c:${id}`),
          visited: visited.has(`c:${id}`),
          vacant,
          knownAddress: null,
        };
      });
    }
    customers.sort((left, right) => Number(right.planned) - Number(left.planned) || left.name.localeCompare(right.name));
  }

  return {
    managerKey: subject.seatId,
    managerName: nameOf(names, subject.hrId),
    date,
    through: viewer.visitDay,
    lists,
    list: asked,
    customers,
    products,
    canRecordDay: daySeat !== null,
    dayActivity: activity,
    activityIsOwn: activity !== null && !activity.enteredByAdmin,
    blockedReason: null,
  };
}

export type EnteredManagerMissedVisit = { customerName: string; planned: boolean; duplicate: boolean };

/** POST: one single visit of his own that he missed logging. */
export async function enterManagerMissedVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<EnteredManagerMissedVisit> {
  const body = record(raw);
  const { subject, writer } = await missedManager(viewer, body.manager);
  const parsed = parseMissedManagerVisit(body, viewer.visitDay);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  if (entry.products.length > 0) {
    const allowed = new Set(await writerProductNames(viewer, writer));
    if (entry.products.some((product) => !allowed.has(product))) throw validationError("Choose the products from the manager's line's products. Reload the page.");
  }

  // Whose customer — a rep's of a territory he reaches, or one of his own list — exactly as he logs one.
  const reach = await managerWriterReach(viewer, writer);
  let customerName = "Customer";
  let customerSeatId: string | null = null;
  if (entry.customerId) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, seat_id, status, is_test").eq("id", entry.customerId as string),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    const row = rows[0];
    if (!row || row.is_test === true || (row.status !== "active" && row.status !== "pending")) {
      throw notFoundError("This customer is no longer on the list. Reload the page.");
    }
    if (!reach.some((seat) => seat.seatId === String(row.seat_id ?? ""))) throw forbiddenError("This customer is outside the territories this manager plans in.");
    customerSeatId = String(row.seat_id);
    customerName = textOrNull(row.name) ?? customerName;
  } else if (entry.managerCustomerId) {
    const own = await loadManagerCustomerRow(entry.managerCustomerId);
    if (!own || own.managerHrId !== subject.hrId || own.isTest || own.status === "removed") {
      throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
    }
    customerSeatId = own.areaSeatId;
    customerName = own.name;
  }
  const customerSeat = customerSeatId ? viewer.org.seats.get(customerSeatId) : undefined;
  const vacant = customerSeatId !== null && isVacantTerritory(customerSeat);
  const placeError = vacantVisitPlaceError({ vacant, address: entry.address, captured: false });
  if (placeError) throw validationError(placeError);

  const slot = (await plannedSlotsOn(subject.hrId, entry.visitDate)).get(entry.customerId ? `c:${entry.customerId}` : `m:${entry.managerCustomerId}`) ?? null;
  const at = missedVisitInstant(entry.visitDate, entry.visitMinute, new Date(), cairoOffsetMinutes);
  const wall = new Date(at.getTime() + cairoOffsetMinutes(at) * 60_000);

  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_visits")
    .insert({
      manager_hr_id: subject.hrId,
      manager_seat_id: writer.seat?.seatId ?? null,
      line_code: writer.seat?.lineCode ?? customerSeat?.lineCode ?? null,
      plan_slot_id: slot?.slotId ?? null,
      is_unplanned: slot === null,
      visit_date: entry.visitDate,
      // The planned half when the plan holds him; otherwise the half the time he gave falls in.
      half: slot?.half ?? singleVisitHalfOfHour(wall.getUTCHours()),
      customer_id: entry.customerId,
      manager_customer_id: entry.managerCustomerId,
      products: entry.products,
      comment: entry.comment,
      captured_at: at.toISOString(),
      in_vacant_territory: vacant,
      address: entry.address,
      area_name: customerSeat?.areaName ?? null,
      client_ref: entry.clientRef,
      // Somebody other than the manager: that is the "Entered by the Super Admin" mark.
      entered_by_hr_id: viewer.hrId,
      is_test: false,
    });
  if (error) {
    if ((error as { code?: unknown }).code !== "23505") throw error;
    const again = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_visits").select("id").eq("client_ref", entry.clientRef),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    if (again.length === 0) throw conflictError("This manager already has a visit to this customer on that day.", "already_visited");
    return { customerName, planned: slot !== null, duplicate: true };
  }
  return { customerName, planned: slot !== null, duplicate: false };
}

/** POST: how a district or regional manager's day was spent — or the clearing of one the Super Admin entered. */
export async function enterManagerMissedActivity(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ cleared: boolean; activity: DayActivityRow | null }> {
  const body = record(raw);
  const { subject, daySeat } = await missedManager(viewer, body.manager);
  if (!daySeat) throw forbiddenError("Only a district or regional manager records a day of their own.");
  const parsed = parseMissedActivity(body, viewer.visitDay);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  // 🔴 His own record stays his: the Super Admin fills a day he left empty, and changes or clears only what
  // he entered himself.
  const existing = await loadDayActivityOn(daySeat.seatId, false, entry.activityDate);
  if (existing && !existing.enteredByAdmin) throw conflictError("The manager recorded this day, so it stays as recorded.", "manager_recorded_day");

  if (entry.clear) {
    await callPhoenixCrm("phoenix_crm_save_day_activity", {
      p: { actor_hr_id: viewer.hrId, activity_date: entry.activityDate, is_test: false, seat_id: daySeat.seatId },
    });
    return { cleared: true, activity: null };
  }
  const saved = await callPhoenixCrm<Row>("phoenix_crm_save_day_activity", {
    p: {
      activity_date: entry.activityDate,
      activity_type: entry.draft.activityType,
      actor_hr_id: viewer.hrId,
      half_day: entry.draft.halfDay,
      is_test: false,
      line_code: daySeat.lineCode,
      note: entry.draft.note,
      rep_hr_id: subject.hrId,
      seat_id: daySeat.seatId,
    },
  });
  const activity = mapDayActivityRow({ ...saved, entered_by_hr_id: viewer.hrId, rep_hr_id: subject.hrId });
  return { cleared: false, activity: activity ?? (await loadDayActivityOn(daySeat.seatId, false, entry.activityDate)) };
}
