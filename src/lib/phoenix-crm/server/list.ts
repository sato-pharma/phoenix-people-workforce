/**
 * Phoenix CRM — a territory's customer list: the iReports360 reference, the validated customers with
 * their places and timings, and the grade and drop requests.
 *
 * Owner, 2026-09-16:
 *   - the rep's iReports360 list is a REFERENCE only; a customer is real once validated with a live
 *     photo, the location captured on the spot and at least one timing;
 *   - a new customer's grade, a grade change and a drop go to the district manager (the territory's
 *     reviewer) — never approved by the system;
 *   - the list stays with the territory when the rep changes.
 *
 * Every write goes through one database function that re-checks the rule under a per-territory lock
 * (supabase/migrations/20260916150000_phoenix_crm.sql); this file checks who may ask, shapes the entry
 * and tells the people who must act.
 */

import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { monthStartOf, nextRamadan } from "@/lib/phoenix-crm/calendar";
import { coverageTier, gradeTarget, summarizeReadiness, type CoverageTier, type ReadinessSummary, type ReferenceState } from "@/lib/phoenix-crm/coverage";
import {
  cleanText,
  DEVICE_CLOCK_TOLERANCE_MINUTES,
  deviceClockSkewMinutes,
  dropReasonLabel,
  parseDropDraft,
  parseGrade,
  parseNewCustomer,
  parsePlaceDraft,
  PLACE_TEXT_MAX,
  type PlaceDraft,
} from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  assertReviewer,
  canReviewTerritory,
  canWriteAsRep,
  readTestFlag,
  territoryForRead,
  territoryForRepWrite,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { parseTimings, sortTimings } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmRequestKind, PhoenixCrmRequestStatus, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

/** A nearest brick centre further than this is not trusted as the place's brick. */
const BRICK_TRUST_KM = 3;
/** Decided requests stay on the rep's screen this long, so the answer is seen. */
const DECIDED_REQUESTS_DAYS = 45;

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type ListPlace = {
  placeId: string;
  label: string | null;
  address: string | null;
  brickId: string | null;
  brickName: string | null;
  zone: string | null;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  timings: PhoenixCrmTiming[];
  photoPath: string;
  capturedAt: string;
  /** The phone's clock was more than 15 minutes off the server's when the photo was taken. */
  clockOff: boolean;
};

export type ListCustomer = {
  customerId: string;
  listType: PhoenixCrmListType;
  name: string;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  origin: "reference" | "new";
  referenceContactCrmId: number | null;
  status: "active" | "dropped";
  validatedAt: string | null;
  droppedReason: string | null;
  droppedNote: string | null;
  statusChangedAt: string;
  places: ListPlace[];
  visitsThisMonth: number;
  target: number | null;
  tier: CoverageTier;
  pendingGradeRequestId: string | null;
  pendingGrade: PhoenixCrmGrade | null;
  pendingDropRequestId: string | null;
};

export type ListReferenceEntry = {
  contactCrmId: number;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  name: string;
  speciality: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
  state: ReferenceState;
  customerId: string | null;
  pendingDropRequestId: string | null;
};

export type ListRequest = {
  requestId: string;
  kind: PhoenixCrmRequestKind;
  status: PhoenixCrmRequestStatus;
  customerId: string | null;
  referenceContactCrmId: number | null;
  customerName: string;
  listType: PhoenixCrmListType;
  currentGrade: PhoenixCrmGrade | null;
  proposedGrade: PhoenixCrmGrade | null;
  dropReason: string | null;
  dropReasonLabel: string | null;
  note: string | null;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type TerritoryListView = {
  territory: TerritorySummary;
  isTest: boolean;
  /** The viewer is the territory's rep (or the Super Admin in test mode): the list can be changed. */
  canEdit: boolean;
  /** The viewer decides this territory's requests. */
  canReview: boolean;
  readiness: ReadinessSummary & { readyAt: string | null };
  /** Whose iReports360 list the reference is; the name is null when that person is not on record. */
  referenceSource: { name: string | null; isCurrent: boolean } | null;
  reference: ListReferenceEntry[];
  customers: ListCustomer[];
  requests: ListRequest[];
  monthStart: string;
  /** What the capture and the timings editor need: the weak-signal warning and the places a customer can hold. */
  rules: { weakGpsMeters: number; placesMax: number };
  /** The Ramadan in force or coming next (with the Super Admin's moved days), for the Ramadan hours note. */
  ramadan: { startsOn: string; endsOn: string } | null;
};

/** The database refuses a sixth active place (phoenix_crm_add_place, too_many_places). */
export const PHOENIX_CRM_PLACES_MAX = 5;

export function mapTimings(raw: unknown): PhoenixCrmTiming[] {
  if (!Array.isArray(raw)) return [];
  const timings: PhoenixCrmTiming[] = [];
  for (const entry of raw) {
    const body = record(entry);
    const weekday = Number(body.weekday);
    const startMinute = Number(body.startMinute);
    const endMinute = body.endMinute === null || body.endMinute === undefined ? null : Number(body.endMinute);
    if (!Number.isInteger(weekday) || !Number.isInteger(startMinute) || (endMinute !== null && !Number.isInteger(endMinute))) continue;
    timings.push({ weekday, startMinute, endMinute, season: body.season === "ramadan" ? "ramadan" : "normal" });
  }
  return sortTimings(timings);
}

export function mapPlaceRow(row: Row): ListPlace {
  const skew = numberOrNull(row.device_skew_minutes);
  return {
    placeId: String(row.id),
    label: text(row.label),
    address: text(row.address),
    brickId: text(row.brick_id),
    brickName: text(row.brick_name),
    zone: text(row.zone),
    lat: Number(row.lat),
    lon: Number(row.lon),
    accuracyMeters: numberOrNull(row.accuracy_meters),
    timings: mapTimings(row.timings),
    photoPath: String(row.photo_path),
    capturedAt: String(row.captured_at),
    clockOff: skew !== null && Math.abs(skew) > DEVICE_CLOCK_TOLERANCE_MINUTES,
  };
}

const PLACE_COLUMNS =
  "id, customer_id, label, address, brick_id, brick_name, zone, lat, lon, accuracy_meters, timings, photo_path, captured_at, device_skew_minutes";
const CUSTOMER_COLUMNS =
  "id, list_type, name, speciality, grade, origin, reference_contact_crm_id, status, validated_at, dropped_reason, dropped_note, status_changed_at";

/** Every customer of a territory (active and dropped), with its active places. */
export async function loadTerritoryCustomers(
  seatId: string,
  isTest: boolean,
  options: { activeOnly?: boolean } = {},
): Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }> {
  const supabase = getSupabaseAdmin();
  const [customers, places] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest);
        if (options.activeOnly) query = query.eq("status", "active");
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () => supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest).eq("status", "active"),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  ]);
  const placesByCustomer = new Map<string, ListPlace[]>();
  for (const row of places) {
    const customerId = String(row.customer_id);
    const list = placesByCustomer.get(customerId) ?? [];
    list.push(mapPlaceRow(row));
    placesByCustomer.set(customerId, list);
  }
  for (const list of placesByCustomer.values()) list.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  return { customers, placesByCustomer };
}

/** Visits a customer this month, by customer id. */
export async function loadMonthVisitCounts(seatId: string, isTest: boolean, monthStart: string, through: string): Promise<Map<string, number>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .gte("visit_date", monthStart)
        .lte("visit_date", through),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const customerId = String(row.customer_id);
    counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
  }
  return counts;
}

type ReferenceRow = {
  seat_id: string;
  source_hr_id: string;
  source_is_current: boolean;
  contact_crm_id: number;
  list_type: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  name: string;
  speciality: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  brick_id: string | null;
  last_visited_on: string | null;
  customer_id: string | null;
  state: ReferenceState;
};

export async function loadReference(seatId: string, isTest: boolean): Promise<ReferenceRow[]> {
  return rpcAll<ReferenceRow>(getSupabaseAdmin(), "phoenix_crm_seat_reference", { p_seat_ids: [seatId], p_is_test: isTest }, [
    "list_type",
    "contact_crm_id",
  ]);
}

export type SeatReadiness = ReadinessSummary & { seatId: string; readyAt: string | null };

/** Real readiness for many territories in one call. With markReady, a complete territory is stamped ready once. */
export async function loadReadiness(seatIds: string[], markReady = false): Promise<Map<string, SeatReadiness>> {
  const readiness = new Map<string, SeatReadiness>();
  for (const part of chunk([...new Set(seatIds)], 150)) {
    const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_seat_readiness", { p_seat_ids: part, p_mark_ready: markReady });
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      const total = Number(row.reference_total ?? 0);
      const validated = Number(row.validated_count ?? 0);
      const dropped = Number(row.dropped_count ?? 0);
      const dropPending = Number(row.drop_pending_count ?? 0);
      const open = Number(row.open_count ?? 0);
      readiness.set(String(row.seat_id), {
        seatId: String(row.seat_id),
        total,
        validated,
        dropped,
        dropPending,
        open,
        // Measured once: a territory stamped ready stays ready when new reference customers appear later.
        ready: Boolean(text(row.ready_at)) || (open === 0 && dropPending === 0),
        readyAt: text(row.ready_at),
      });
    }
  }
  return readiness;
}

export function mapRequestRow(row: Row, names: ReadonlyMap<string, string>): ListRequest {
  const dropReason = text(row.drop_reason);
  return {
    requestId: String(row.id),
    kind: row.kind === "drop" ? "drop" : "grade",
    status: String(row.status) as PhoenixCrmRequestStatus,
    customerId: text(row.customer_id),
    referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
    customerName: String(row.customer_name),
    listType: row.list_type === "AM" ? "AM" : "PM",
    currentGrade: parseGrade(row.current_grade),
    proposedGrade: parseGrade(row.proposed_grade),
    dropReason,
    dropReasonLabel: dropReasonLabel(dropReason),
    note: text(row.note),
    requestedByName: nameOf(names, text(row.requested_by_hr_id)),
    requestedAt: String(row.requested_at),
    decidedByName: text(row.decided_by_hr_id) ? nameOf(names, text(row.decided_by_hr_id)) : null,
    decidedAt: text(row.decided_at),
    decisionNote: text(row.decision_note),
  };
}

const REQUEST_COLUMNS =
  "id, seat_id, kind, status, customer_id, reference_contact_crm_id, customer_name, list_type, current_grade, proposed_grade, drop_reason, note, requested_by_hr_id, requested_at, decided_by_hr_id, decided_at, decision_note, is_test";

/** Waiting requests, and the ones decided lately, for some territories. */
export async function loadRequestRows(seatIds: string[], isTest: boolean, options: { pendingOnly?: boolean } = {}): Promise<Row[]> {
  const since = new Date(Date.now() - DECIDED_REQUESTS_DAYS * 86400000).toISOString();
  const rows: Row[] = [];
  for (const part of chunk([...new Set(seatIds)], 100)) {
    const page = await fetchAllRowsKeyset<Row>(
      () => {
        let query = getSupabaseAdmin().from("phoenix_crm_list_requests").select(REQUEST_COLUMNS).in("seat_id", part).eq("is_test", isTest);
        query = options.pendingOnly ? query.eq("status", "pending") : query.or(`status.eq.pending,decided_at.gte.${since}`);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    rows.push(...page);
  }
  return rows.sort((left, right) => String(right.requested_at).localeCompare(String(left.requested_at)));
}

export async function loadTerritoryList(viewer: PhoenixCrmViewer, seatId: unknown, test: unknown): Promise<TerritoryListView> {
  const { seat, isTest } = territoryForRead(viewer, seatId, readTestFlag(test));
  const monthStart = monthStartOf(viewer.cairoToday);
  const [reference, { customers, placesByCustomer }, requestRows, visitCounts, readinessMap] = await Promise.all([
    loadReference(seat.seatId, isTest),
    loadTerritoryCustomers(seat.seatId, isTest),
    loadRequestRows([seat.seatId], isTest),
    loadMonthVisitCounts(seat.seatId, isTest, monthStart, viewer.cairoToday),
    isTest ? Promise.resolve(null) : loadReadiness([seat.seatId]),
  ]);

  const names = await loadPeopleNames([
    ...territoryPeople(viewer.org, [seat]),
    ...requestRows.flatMap((row) => [text(row.requested_by_hr_id), text(row.decided_by_hr_id)]),
    reference[0]?.source_hr_id ?? null,
  ]);
  const requests = requestRows.map((row) => mapRequestRow(row, names));
  const pendingByCustomer = new Map<string, { grade?: ListRequest; drop?: ListRequest }>();
  const pendingDropByContact = new Map<number, ListRequest>();
  for (const request of requests) {
    if (request.status !== "pending") continue;
    if (request.customerId) {
      const entry = pendingByCustomer.get(request.customerId) ?? {};
      entry[request.kind] = request;
      pendingByCustomer.set(request.customerId, entry);
    } else if (request.kind === "drop" && request.referenceContactCrmId !== null) {
      pendingDropByContact.set(request.referenceContactCrmId, request);
    }
  }

  const listCustomers: ListCustomer[] = customers.map((row) => {
    const customerId = String(row.id);
    const listType: PhoenixCrmListType = row.list_type === "AM" ? "AM" : "PM";
    const grade = parseGrade(row.grade);
    const visits = visitCounts.get(customerId) ?? 0;
    const target = gradeTarget(viewer.config.settings, listType, grade);
    const pending = pendingByCustomer.get(customerId);
    const droppedReason = text(row.dropped_reason);
    return {
      customerId,
      listType,
      name: String(row.name),
      speciality: text(row.speciality),
      grade,
      origin: row.origin === "new" ? "new" : "reference",
      referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
      status: row.status === "dropped" ? "dropped" : "active",
      validatedAt: text(row.validated_at),
      droppedReason: dropReasonLabel(droppedReason) ?? droppedReason,
      droppedNote: text(row.dropped_note),
      statusChangedAt: String(row.status_changed_at),
      places: placesByCustomer.get(customerId) ?? [],
      visitsThisMonth: visits,
      target,
      tier: coverageTier(visits, target),
      pendingGradeRequestId: pending?.grade?.requestId ?? null,
      pendingGrade: pending?.grade?.proposedGrade ?? null,
      pendingDropRequestId: pending?.drop?.requestId ?? null,
    };
  });
  listCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  const referenceEntries: ListReferenceEntry[] = reference.map((row) => ({
    contactCrmId: Number(row.contact_crm_id),
    listType: row.list_type,
    grade: parseGrade(row.grade),
    name: row.name,
    speciality: row.speciality,
    address: row.address,
    city: row.city,
    zone: row.zone,
    lastVisitedOn: row.last_visited_on,
    state: row.state,
    customerId: row.customer_id,
    pendingDropRequestId: pendingDropByContact.get(Number(row.contact_crm_id))?.requestId ?? null,
  }));

  const summary = summarizeReadiness(referenceEntries.map((entry) => entry.state));
  const stored = readinessMap?.get(seat.seatId) ?? null;
  const source = reference[0] ?? null;
  const ramadan = nextRamadan(viewer.cairoToday, viewer.config.ramadanOverrides);

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    canEdit: canWriteAsRep(viewer, seat, isTest),
    canReview: canReviewTerritory(viewer, seat, isTest),
    readiness: { ...summary, ready: summary.ready || Boolean(stored?.readyAt), readyAt: stored?.readyAt ?? null },
    referenceSource: source ? { name: nameOf(names, source.source_hr_id, "") || null, isCurrent: source.source_is_current } : null,
    reference: referenceEntries,
    customers: listCustomers,
    requests,
    monthStart,
    rules: { weakGpsMeters: viewer.config.settings.weakGpsMeters, placesMax: PHOENIX_CRM_PLACES_MAX },
    ramadan: ramadan ? { startsOn: ramadan.startsOn, endsOn: ramadan.endsOn } : null,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────

function lineCodeOf(seat: OrgSeat): string {
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so its list cannot be changed.");
  return seat.lineCode;
}

/** The place as the database function reads it: the brick from the location, the phone clock compared. */
async function placePayload(place: PlaceDraft): Promise<Row> {
  const [centroids, issuedAt] = await Promise.all([loadBrickCentroids(), photoSlotIssuedAt(place.photoPath)]);
  const brick = resolveBrickForPoint(place.lat, place.lon, centroids);
  const trusted = brick && brick.distanceKm <= BRICK_TRUST_KM ? brick : null;
  return {
    photo_path: place.photoPath,
    lat: place.lat,
    lon: place.lon,
    accuracy_meters: place.accuracyMeters,
    device_skew_minutes: issuedAt ? deviceClockSkewMinutes(place.deviceCapturedAt, new Date(issuedAt)) : null,
    label: place.label,
    address: place.address,
    brick_id: trusted?.brickId ?? null,
    brick_name: trusted?.brickName ?? place.brick,
    zone: place.zone,
    timings: place.timings,
  };
}

export type ValidateResult = {
  customerId: string;
  customerName: string;
  listType: PhoenixCrmListType;
  placeId: string;
  capturedAt: string;
  restored: boolean;
  gradeRequestId: string | null;
};

export async function validateCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<ValidateResult> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const place = parsePlaceDraft(body.place);
  if (!place.ok) throw validationError(place.error);

  const payload: Row = { seat_id: seat.seatId, line_code: lineCode, actor_hr_id: viewer.hrId, is_test: isTest };
  let proposedGrade: PhoenixCrmGrade | null = null;
  const mode = String(body.mode ?? "");
  if (mode === "reference") {
    const contact = Number(body.referenceContactCrmId);
    if (!Number.isSafeInteger(contact) || contact <= 0) throw validationError("Choose the customer from your reference list.");
    payload.mode = "reference";
    payload.reference_contact_crm_id = contact;
  } else if (mode === "new") {
    const draft = parseNewCustomer(body.customer);
    if (!draft.ok) throw validationError(draft.error);
    proposedGrade = draft.value.proposedGrade;
    Object.assign(payload, {
      mode: "new",
      name: draft.value.name,
      list_type: draft.value.listType,
      speciality: draft.value.speciality,
      proposed_grade: draft.value.proposedGrade,
      allow_same_name: body.allowSameName === true,
    });
  } else if (mode === "restore") {
    if (!isUuid(body.customerId)) throw validationError("Choose the customer to bring back to the list.");
    payload.mode = "restore";
    payload.customer_id = String(body.customerId).toLowerCase();
  } else {
    throw validationError("Reload the page and try again.");
  }
  payload.place = await placePayload(place.value);

  const result = await callPhoenixCrm<Row>("phoenix_crm_validate_customer", { p: payload });
  const validated: ValidateResult = {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    listType: result.list_type === "AM" ? "AM" : "PM",
    placeId: String(result.place_id),
    capturedAt: String(result.captured_at),
    restored: result.restored === true,
    gradeRequestId: text(result.grade_request_id),
  };
  if (validated.gradeRequestId) {
    await notifyPhoenixCrm(
      {
        kind: "request_created",
        org: viewer.org,
        seat,
        requestId: validated.gradeRequestId,
        requestKind: "grade",
        requesterHrId: viewer.hrId,
        customerName: validated.customerName,
        listType: validated.listType,
        proposedGrade,
        dropReason: null,
      },
      isTest,
    );
  }
  return validated;
}

export async function addPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; customerId: string; customerName: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer this place belongs to.");
  const place = parsePlaceDraft(body.place);
  if (!place.ok) throw validationError(place.error);
  const result = await callPhoenixCrm<Row>("phoenix_crm_add_place", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      place: await placePayload(place.value),
    },
  });
  return { placeId: String(result.place_id), customerId: String(result.customer_id), customerName: String(result.customer_name) };
}

/** Editing a place's timings and details (no new photo: the change is kept in the events), or removing it. */
export async function updatePlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; customerId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.placeId)) throw validationError("Choose the place to change.");
  const placeId = String(body.placeId).toLowerCase();
  const action = body.action === "retire" ? "retire" : body.action === "edit" ? "edit" : null;
  if (!action) throw validationError("Reload the page and try again.");

  const payload: Row = { seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest, place_id: placeId, action };
  if (action === "edit") {
    const timings = parseTimings(body.timings);
    if (!timings.ok) throw validationError(timings.error);
    // The function writes every detail it is given, so the brick (set from the location, which an edit
    // never moves) is passed back as it is.
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("brick_id, brick_name")
      .eq("id", placeId)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .maybeSingle();
    throwIfError(error);
    if (!data) throw notFoundError("This place is no longer on the list. Reload the list.");
    const current = data as Row;
    Object.assign(payload, {
      timings: timings.timings,
      label: cleanText(body.label, PLACE_TEXT_MAX),
      address: cleanText(body.address, PLACE_TEXT_MAX),
      zone: cleanText(body.zone, 80),
      brick_id: text(current.brick_id),
      brick_name: text(current.brick_name),
    });
  }
  const result = await callPhoenixCrm<Row>("phoenix_crm_update_place", { p: payload });
  return { placeId: String(result.place_id), customerId: String(result.customer_id) };
}

export async function createListRequest(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const kind = body.kind === "grade" ? "grade" : body.kind === "drop" ? "drop" : null;
  if (!kind) throw validationError("Reload the page and try again.");
  const customerId = isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null;
  const contact = Number(body.referenceContactCrmId);
  const referenceContactCrmId = !customerId && Number.isSafeInteger(contact) && contact > 0 ? contact : null;
  if (!customerId && referenceContactCrmId === null) throw validationError("Choose the customer this request is for.");

  const payload: Row = {
    seat_id: seat.seatId,
    line_code: lineCode,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    kind,
    customer_id: customerId,
    reference_contact_crm_id: referenceContactCrmId,
  };
  let proposedGrade: PhoenixCrmGrade | null = null;
  let dropReason: string | null = null;
  if (kind === "grade") {
    proposedGrade = parseGrade(body.proposedGrade);
    if (!proposedGrade) throw validationError("Choose the grade you propose (A, B or C).");
    payload.proposed_grade = proposedGrade;
  } else {
    const drop = parseDropDraft(body);
    if (!drop.ok) throw validationError(drop.error);
    dropReason = drop.value.reason;
    payload.drop_reason = drop.value.reason;
    payload.note = drop.value.note;
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_create_request", { p: payload });
  const requestId = String(result.request_id);
  await notifyPhoenixCrm(
    {
      kind: "request_created",
      org: viewer.org,
      seat,
      requestId,
      requestKind: kind,
      requesterHrId: viewer.hrId,
      customerName: String(result.customer_name),
      listType: result.list_type === "AM" ? "AM" : "PM",
      proposedGrade,
      dropReason,
    },
    isTest,
  );
  return { requestId };
}

export async function withdrawListRequest(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.requestId)) throw validationError("Choose the request to withdraw.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_withdraw_request", {
    p: { seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest, request_id: String(body.requestId).toLowerCase() },
  });
  return { requestId: String(result.request_id) };
}

/** The reviewing manager's decision on a grade or drop request. Refusing needs a note for the rep. */
export async function decideListRequest(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; status: "approved" | "refused" }> {
  const body = record(raw);
  if (!isUuid(body.requestId)) throw validationError("Choose the request to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "refuse" ? "refuse" : null;
  if (!decision) throw validationError("Choose approve or refuse.");
  const note = cleanText(body.note, 500);
  if (decision === "refuse" && !note) throw validationError("Write a note for the rep explaining why.");

  const requestId = String(body.requestId).toLowerCase();
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_list_requests").select("id, seat_id, is_test").eq("id", requestId).maybeSingle();
  throwIfError(error);
  const request = data as Row | null;
  if (!request) throw notFoundError("This request is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(request.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = request.is_test === true;
  assertReviewer(viewer, seat, isTest);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, is_test: isTest, decision, note },
  });
  const status = result.status === "approved" ? "approved" : "refused";
  const requesterHrId = text(result.requested_by_hr_id);
  if (requesterHrId) {
    await notifyPhoenixCrm(
      {
        kind: "request_decided",
        seat,
        requestId,
        requestKind: result.kind === "drop" ? "drop" : "grade",
        status,
        deciderHrId: viewer.hrId,
        requesterHrId,
        customerName: String(result.customer_name),
        proposedGrade: text(result.proposed_grade),
        note,
      },
      isTest,
    );
  }
  return { requestId, status };
}
