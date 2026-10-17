/**
 * Phoenix CRM — "Manager's own list" and the customers a district manager chooses for a single visit.
 *
 * Owner, 2026-10-16: "the district manager should have two lists. The list which is of all his medical
 * reps and a separate list that he did the single visits before." The two are NEVER merged: a customer
 * he adds himself lives in `phoenix_crm_manager_customers`, graded by him (A/B/C and the potential
 * grade), with NO validation step ("there will not be validation because they are managers") and an
 * optional Capture location whose address, area and brick are resolved here, server-side. A name he
 * types that is already on one of the lists is OFFERED first — namesakes are real, so he may still say it
 * is a different person. Taking a customer off his own list waits for his RSM/NSM's approval.
 *
 * 🔴 NOTHING HERE TOUCHES A REP'S LIST. No row is written to `phoenix_crm_customers` or
 * `phoenix_crm_places`, and nothing in his own list counts in a rep's or the district's coverage, call
 * rate, frequency or target.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { parseCapturedFix, parseCustomerPhone } from "@/lib/phoenix-crm/entry-rules";
import {
  isManagerCustomerGrade,
  isManagerCustomerPotentialGrade,
  managerPlanApprovers,
  matchCustomerName,
  MANAGER_PLAN_NOTE_MAX,
  MANAGER_PLAN_REASON_MAX,
  type NameCandidate,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import {
  assertManagerPlanWriter,
  managerAskDeciderRole,
  managerDistrictSeats,
  managerPlace,
  managerPlanSeatOf,
  readsManagerPlanOf,
  resolveManagerPlanReader,
} from "@/lib/phoenix-crm/server/manager-plan-reach";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { resolvePinGeography, territoryOfSeat } from "@/lib/phoenix-crm/server/place-location";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function cleanText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw validationError(`${field} could not be read.`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw validationError(`Keep ${field.toLowerCase()} under ${max} characters.`);
  return text.length > 0 ? text : null;
}

// ── Manager's own list ──────────────────────────────────────────────────────────────────────────

export type ManagerCustomerStatus = "active" | "removal_pending" | "removed";

export type ManagerCustomerView = {
  id: string;
  name: string;
  speciality: string | null;
  phone: string | null;
  contactNote: string | null;
  grade: string;
  potentialGrade: string;
  comment: string | null;
  areaSeatId: string | null;
  areaName: string | null;
  /** Where his captured location resolved, when he captured one: the address, then the brick. */
  address: string | null;
  brickName: string | null;
  hasPin: boolean;
  status: ManagerCustomerStatus;
  statusLabel: string;
  removalReason: string | null;
  removalDecisionNote: string | null;
};

const OWN_COLUMNS =
  "id, manager_hr_id, line_code, name, speciality, phone, contact_note, grade, potential_grade, comment, area_seat_id, area_code, area_name, pin_lat, pin_lon, pin_address, pin_brick_name, status, removal_reason, removal_requested_at, removal_approver_hr_id, removal_decision_note, is_test, created_at";

function statusLabelOf(status: ManagerCustomerStatus): string {
  if (status === "removal_pending") return "Waiting to come off the list";
  if (status === "removed") return "Off the list";
  return "On the list";
}

export function managerCustomerOf(
  raw: unknown,
): (ManagerCustomerView & { managerHrId: string; approverHrId: string | null; isTest: boolean; removalRequestedAt: string | null }) | null {
  const row = record(raw);
  const id = textOrNull(row.id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const name = textOrNull(row.name);
  if (!id || !managerHrId || !name) return null;
  const status: ManagerCustomerStatus = row.status === "removal_pending" || row.status === "removed" ? row.status : "active";
  return {
    id,
    managerHrId,
    name,
    speciality: textOrNull(row.speciality),
    phone: textOrNull(row.phone),
    contactNote: textOrNull(row.contact_note),
    grade: textOrNull(row.grade) ?? "",
    potentialGrade: textOrNull(row.potential_grade) ?? "",
    comment: textOrNull(row.comment),
    areaSeatId: textOrNull(row.area_seat_id),
    areaName: textOrNull(row.area_name),
    address: textOrNull(row.pin_address),
    brickName: textOrNull(row.pin_brick_name),
    hasPin: row.pin_lat !== null && row.pin_lat !== undefined,
    status,
    statusLabel: statusLabelOf(status),
    removalReason: textOrNull(row.removal_reason),
    removalRequestedAt: textOrNull(row.removal_requested_at),
    removalDecisionNote: textOrNull(row.removal_decision_note),
    approverHrId: personKey(textOrNull(row.removal_approver_hr_id)),
    isTest: row.is_test === true,
  };
}

/** His own list, in one world: every customer still on it (and those waiting to come off), by name. */
export async function loadManagerCustomers(managerHrId: string, isTest: boolean): Promise<ManagerCustomerView[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_customers")
        .select(OWN_COLUMNS)
        .eq("manager_hr_id", managerHrId)
        .eq("is_test", isTest)
        .neq("status", "removed"),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows
    .map(managerCustomerOf)
    .filter((row): row is NonNullable<ReturnType<typeof managerCustomerOf>> => row !== null)
    .map(({ managerHrId: _manager, approverHrId: _approver, isTest: _test, removalRequestedAt: _requested, ...view }) => view)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** One own-list customer by its id. */
export async function loadManagerCustomerRow(id: string) {
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_customers").select(OWN_COLUMNS).eq("id", id),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.length > 0 ? managerCustomerOf(rows[0]) : null;
}

export type ManagerOwnListView = {
  isTest: boolean;
  mode: "own" | "pick";
  /** "pick" mode: every district manager he reads, to choose whose list. Null in "own" mode. */
  managers: Array<{ hrId: string; name: string; place: string }> | null;
  canWrite: boolean;
  manager: { hrId: string; name: string } | null;
  /** The areas of his district, for Add a customer. */
  areas: Array<{ seatId: string; areaName: string }>;
  customers: ManagerCustomerView[];
  /** Who decides a removal: his RSM/NSM. */
  approverName: string | null;
};

/** GET: Manager's own list — his own, or a district manager's a reader above him picked. */
export async function loadManagerOwnList(viewer: PhoenixCrmViewer, raw: { manager: unknown; test: unknown }): Promise<ManagerOwnListView> {
  const isTest = testModeFor(viewer, raw.test);
  const reader = resolveManagerPlanReader(viewer, raw.manager);
  const pickNames = reader.mode === "pick" ? await loadPeopleNames(reader.managers.map((entry) => entry.hrId)) : new Map<string, string>();
  const managers =
    reader.mode === "pick"
      ? reader.managers
          .map((entry) => ({ hrId: entry.hrId, name: nameOf(pickNames, entry.hrId), place: managerPlace(entry.seat) }))
          .sort((left, right) => left.place.localeCompare(right.place) || left.name.localeCompare(right.name))
      : null;
  const asked = reader.managerHrId;
  if (!asked) return { isTest, mode: reader.mode, managers, canWrite: false, manager: null, areas: [], customers: [], approverName: null };
  if (!readsManagerPlanOf(viewer, asked)) throw forbiddenError("Manager's own list is read by that district manager and the managers above that seat.");
  const seat = managerPlanSeatOf(viewer, asked);
  const approver = seat ? managerPlanApprovers(viewer.org, seat.seatId).first : null;
  const [customers, names] = await Promise.all([loadManagerCustomers(asked, isTest), loadPeopleNames([asked, approver?.hrId])]);
  return {
    isTest,
    mode: reader.mode,
    managers,
    canWrite: asked === viewer.hrId && viewer.canCreate && !viewer.isSuperAdmin && seat !== null,
    manager: { hrId: asked, name: nameOf(names, asked) },
    areas: areasOf(managerDistrictSeats(viewer, asked)),
    customers,
    approverName: approver ? nameOf(names, approver.hrId) : null,
  };
}

function areasOf(seats: ReadonlyArray<OrgSeat>): Array<{ seatId: string; areaName: string }> {
  const seen = new Set<string>();
  const out: Array<{ seatId: string; areaName: string }> = [];
  for (const seat of seats) {
    const key = seat.areaCode ?? seat.areaName ?? seat.seatId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seatId: seat.seatId, areaName: seat.areaName ?? territoryName(seat) });
  }
  return out.sort((left, right) => left.areaName.localeCompare(right.areaName));
}

// ── A single visit's customers: the area's rep list and his own ─────────────────────────────────

export type AreaCustomer = {
  customerId: string;
  name: string;
  grade: string | null;
  speciality: string | null;
  listType: "AM" | "PM";
  seatId: string;
  repName: string | null;
};

/** The customers of the rep lists of these seats — AM and PM, active or not validated yet; never a pharmacy. */
async function loadRepListCustomers(seatIds: ReadonlyArray<string>, isTest: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk(dedupeIds(seatIds), 50)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_customers")
            .select("id, seat_id, name, grade, speciality, list_type, status")
            .in("seat_id", part)
            .eq("is_test", isTest)
            .in("status", ["active", "pending"])
            .in("list_type", ["AM", "PM"]),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

export type AreaCustomersView = {
  area: { seatId: string; areaName: string } | null;
  repList: AreaCustomer[];
  ownList: ManagerCustomerView[];
};

/**
 * GET: the customers he chooses from for a single visit in one area of his district — that area's rep
 * lists (every territory of the area, a vacant one included) and Manager's own list. His own only.
 */
export async function loadAreaCustomers(viewer: PhoenixCrmViewer, raw: { area: unknown; test: unknown }): Promise<AreaCustomersView> {
  assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const district = managerDistrictSeats(viewer, viewer.hrId);
  const chosen = district.find((seat) => seat.seatId === raw.area) ?? null;
  if (!chosen) throw forbiddenError("Choose an area of your own district.");
  const areaKey = chosen.areaCode ?? chosen.areaName ?? chosen.seatId;
  const seats = district.filter((seat) => (seat.areaCode ?? seat.areaName ?? seat.seatId) === areaKey);
  const [rows, ownList, names] = await Promise.all([
    loadRepListCustomers(seats.map((seat) => seat.seatId), isTest),
    loadManagerCustomers(viewer.hrId, isTest),
    loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
  ]);
  const repOf = new Map(seats.map((seat) => [seat.seatId, seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null]));
  const repList = rows
    .flatMap((row): AreaCustomer[] => {
      const customerId = textOrNull(row.id);
      const seatId = textOrNull(row.seat_id);
      const listType = row.list_type === "AM" || row.list_type === "PM" ? row.list_type : null;
      if (!customerId || !seatId || !listType) return [];
      return [
        {
          customerId,
          name: textOrNull(row.name) ?? "Customer",
          grade: textOrNull(row.grade),
          speciality: textOrNull(row.speciality),
          listType,
          seatId,
          repName: repOf.get(seatId) ?? null,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    area: { seatId: chosen.seatId, areaName: chosen.areaName ?? territoryName(chosen) },
    repList,
    ownList: ownList.filter((customer) => customer.status === "active"),
  };
}

// ── A name he typed: the match first ────────────────────────────────────────────────────────────

export type CustomerMatch = NameCandidate & { detail: string };

/**
 * POST: the customers already on his reps' lists or his own list under the name he typed, so he can pick
 * the existing one rather than add a second (owner, 2026-10-16). Folded the way the duplicate board folds
 * names. An offer, never a decision: namesakes are real.
 */
export async function matchManagerCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<CustomerMatch[]> {
  assertManagerPlanWriter(viewer);
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const typed = cleanText(body.name, 200, "The name");
  if (!typed) return [];
  const district = managerDistrictSeats(viewer, viewer.hrId);
  const [rows, own, names] = await Promise.all([
    loadRepListCustomers(district.map((seat) => seat.seatId), isTest),
    loadManagerCustomers(viewer.hrId, isTest),
    loadPeopleNames(district.map((seat) => seat.occupantHrId)),
  ]);
  const seatById = new Map(district.map((seat) => [seat.seatId, seat]));
  const candidates: CustomerMatch[] = [
    ...rows.flatMap((row): CustomerMatch[] => {
      const id = textOrNull(row.id);
      const name = textOrNull(row.name);
      const seat = seatById.get(String(row.seat_id ?? ""));
      if (!id || !name || !seat) return [];
      const rep = seat.occupantHrId ? nameOf(names, seat.occupantHrId) : "No rep";
      const detail = [textOrNull(row.speciality), `${rep}'s list`, seat.areaName].filter(Boolean).join(" · ");
      return [{ id, name, source: "rep", detail }];
    }),
    ...own
      .filter((customer) => customer.status === "active")
      .map((customer): CustomerMatch => ({
        id: customer.id,
        name: customer.name,
        source: "own",
        detail: [customer.speciality, "Manager's own list", customer.areaName].filter(Boolean).join(" · "),
      })),
  ];
  return matchCustomerName(typed, candidates);
}

// ── Adding one ──────────────────────────────────────────────────────────────────────────────────

const EGYPT = { latMin: 21.5, latMax: 32, lonMin: 24, lonMax: 37.5 };

/**
 * POST: a customer he adds to his own list. Name, speciality, phone or contact, the grade and the
 * potential grade, an area of his district, an optional comment, and an optional captured location —
 * NO accuracy gate and no photo ("he is a manager, not a rep at a door"), resolved to an address, area
 * and brick here. Never a validation step.
 */
export async function addManagerCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerCustomerView> {
  const seat = assertManagerPlanWriter(viewer);
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const name = cleanText(body.name, 200, "The name");
  if (!name) throw validationError("Write the customer's name.");
  const speciality = cleanText(body.speciality, 120, "The speciality");
  const contactNote = cleanText(body.contactNote, 300, "The contact note");
  const comment = cleanText(body.comment, MANAGER_PLAN_NOTE_MAX, "The comment");
  const phone = parseCustomerPhone(body.phone);
  if (!phone.ok) throw validationError(phone.error);
  if (!isManagerCustomerGrade(body.grade)) throw validationError("Choose the grade: A, B or C.");
  if (!isManagerCustomerPotentialGrade(body.potentialGrade)) throw validationError("Choose the potential grade.");
  const district = managerDistrictSeats(viewer, viewer.hrId);
  const area = district.find((entry) => entry.seatId === body.areaSeatId) ?? null;
  if (!area) throw validationError("Choose the area of your district the customer is in.");

  let pin: Row = {};
  const rawPin = record(body.pin);
  if (rawPin.lat !== undefined || rawPin.lon !== undefined) {
    const fix = parseCapturedFix(rawPin, "The location could not be read. Press Capture location again, or add the customer without it.");
    if (!fix.ok) throw validationError(fix.error);
    const { lat, lon, accuracyMeters } = fix.value;
    if (lat < EGYPT.latMin || lat > EGYPT.latMax || lon < EGYPT.lonMin || lon > EGYPT.lonMax) {
      throw validationError("This location is outside Egypt. Capture it again at the customer, or add the customer without it.");
    }
    const geography = await resolvePinGeography({ lat, lon, accuracyMeters }, territoryOfSeat(area));
    pin = {
      pin_lat: lat,
      pin_lon: lon,
      pin_accuracy_meters: accuracyMeters,
      pin_address: geography.address,
      pin_governorate: geography.governorate,
      pin_area_code: geography.areaCode,
      pin_area_name: geography.areaName,
      pin_brick_id: geography.brickId,
      pin_brick_name: geography.brickName,
      pin_brick_distance_km: geography.brickDistanceKm,
      pin_brick_lookup: geography.brickLookup,
      pinned_at: new Date().toISOString(),
    };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_customers")
    .insert({
      manager_hr_id: viewer.hrId,
      line_code: seat.lineCode,
      name,
      speciality,
      phone: phone.value,
      contact_note: contactNote,
      grade: body.grade,
      potential_grade: body.potentialGrade,
      comment,
      area_seat_id: area.seatId,
      area_code: area.areaCode ?? null,
      area_name: area.areaName ?? territoryName(area),
      ...pin,
      status: "active",
      created_by_hr_id: viewer.hrId,
      is_test: isTest,
    })
    .select(OWN_COLUMNS)
    .single();
  if (error) throw error;
  const added = managerCustomerOf(data);
  if (!added) throw conflictError("The customer could not be added. Reload the page and try again.");
  const { managerHrId: _manager, approverHrId: _approver, isTest: _test, removalRequestedAt: _requested, ...view } = added;
  return view;
}

// ── Taking one off his own list ─────────────────────────────────────────────────────────────────

/** POST: he asks to take a customer off his own list; his RSM/NSM decides (owner, 2026-10-16). */
export async function requestManagerCustomerRemoval(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerCustomerView> {
  const seat = assertManagerPlanWriter(viewer);
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const id = textOrNull(body.id);
  if (!id) throw validationError("This customer could not be read. Reload the page.");
  const row = await loadManagerCustomerRow(id);
  if (!row || row.managerHrId !== viewer.hrId || row.isTest !== isTest) throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
  const reason = cleanText(body.reason, MANAGER_PLAN_REASON_MAX, "The reason");
  if (!reason || reason.length < 3) throw validationError("Write why the customer should come off your list.");
  const approver = managerPlanApprovers(viewer.org, seat.seatId).first;
  await callPhoenixCrm<Row>("phoenix_crm_request_manager_customer_removal", {
    p: { manager_customer_id: id, actor_hr_id: viewer.hrId, approver_hr_id: approver?.hrId ?? null, reason, is_test: isTest },
  });
  if (approver) {
    await notifyPhoenixCrm(
      {
        kind: "manager_plan",
        seat,
        step: "removal_waiting",
        recipientHrId: approver.hrId,
        managerHrId: viewer.hrId,
        actorHrId: viewer.hrId,
        recordId: id,
        planId: null,
        weekStart: null,
        version: Date.now(),
        note: reason,
        customerName: row.name,
        byAdministrator: false,
      },
      isTest,
    );
  }
  const updated = await loadManagerCustomerRow(id);
  if (!updated) throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
  const { managerHrId: _manager, approverHrId: _approver, isTest: _test, removalRequestedAt: _requested, ...view } = updated;
  return view;
}

/** POST: his RSM/NSM — or the Administrator — approves or refuses taking a customer off his list. */
export async function decideManagerCustomerRemoval(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ id: string; status: ManagerCustomerStatus }> {
  const body = record(raw);
  const decision = body.decision;
  if (decision !== "approve" && decision !== "refuse") throw validationError("Choose Approve or Refuse.");
  const id = textOrNull(body.id);
  if (!id) throw validationError("This customer could not be read. Reload the page.");
  const isTest = testModeFor(viewer, body.test);
  const row = await loadManagerCustomerRow(id);
  if (!row || row.isTest !== isTest) throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
  const role = managerAskDeciderRole(viewer, { approverHrId: row.approverHrId, isTest });
  if (!role) throw forbiddenError("This removal is decided by the manager above the district manager.");
  // The decision is on the ask the approver read. A refused ask raised again is a NEW ask with its own
  // time, so a page left open on the old one cannot approve the new one unread.
  const requestedAt = textOrNull(body.requestedAt);
  if (!requestedAt || requestedAt !== row.removalRequestedAt) {
    throw conflictError("This ask changed since you opened it. Reload the page and read it again.");
  }
  const note = cleanText(body.note, MANAGER_PLAN_REASON_MAX, "The note");
  if (decision === "refuse" && !note) throw validationError("Write why the customer stays on the list.");
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_decide_manager_customer_removal", {
      p: { manager_customer_id: id, decision, actor_hr_id: viewer.hrId, actor_role: role, note, is_test: isTest },
    }),
  );
  const seat = managerPlanSeatOf(viewer, row.managerHrId);
  if (seat) {
    await notifyPhoenixCrm(
      {
        kind: "manager_plan",
        seat,
        step: "removal_decided",
        recipientHrId: row.managerHrId,
        managerHrId: row.managerHrId,
        actorHrId: viewer.hrId,
        recordId: id,
        planId: null,
        weekStart: null,
        version: Date.now(),
        note,
        customerName: row.name,
        byAdministrator: role === "administrator",
        approved: decision === "approve",
      },
      isTest,
    );
  }
  const status: ManagerCustomerStatus = result.status === "removed" ? "removed" : "active";
  return { id, status };
}
