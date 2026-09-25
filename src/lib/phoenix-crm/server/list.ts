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
import { resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { monthStartOf, nextRamadan } from "@/lib/phoenix-crm/calendar";
import { coverageTier, gradeTarget, summarizeReadiness, type CoverageTier, type ReadinessSummary, type ReferenceState } from "@/lib/phoenix-crm/coverage";
import {
  cleanText,
  CUSTOMER_NAME_MAX,
  DEVICE_CLOCK_TOLERANCE_MINUTES,
  deviceClockSkewMinutes,
  dropReasonLabel,
  parseDropDraft,
  parseGrade,
  parseNewCustomer,
  parsePlaceDraft,
  parseProductAvailability,
  PHARMACY_NAME_MAX,
  PLACE_TEXT_MAX,
  type PlaceDraft,
  type ProductAvailability,
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
import { judgeCapture } from "@/lib/phoenix-crm/server/location-integrity";
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

/**
 * A place as it was captured. Everything below the label is the location, resolved on the server from
 * the coordinates the camera reported and never editable afterwards (owner, 2026-09-23): the clean
 * address, the part of town, the Phoenix brick with the distance that justifies it, that brick's area
 * and region, and the raw fix itself.
 */
export type ListPlace = {
  placeId: string;
  label: string | null;
  address: string | null;
  brickId: string | null;
  brickName: string | null;
  /** How far the point was from that brick's centre — the only place a wrong brick is visible. */
  brickDistanceKm: number | null;
  areaCode: string | null;
  areaName: string | null;
  regionCode: string | null;
  regionName: string | null;
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

/** What iReports360 said about a carried-over customer, so the rep can find him before he has a place. */
export type ListCustomerReference = {
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
};

/**
 * A pharmacy the rep took feedback from for this doctor, built from the visits that named it
 * (phoenix_crm_visits.pharmacy_name). The doctor↔pharmacy link is derived, not maintained: pharmacies
 * are free text, so they are grouped case-insensitively and the display name is the most recent
 * spelling. The rep pins one as primary (phoenix_crm_customers.primary_pharmacy_name).
 */
export type CustomerPharmacy = {
  /** The pharmacy as most recently spelled by the rep. */
  name: string;
  /** Matches the doctor's pinned primary (compared on the normalized name). */
  isPrimary: boolean;
  /** When feedback last named this pharmacy for this doctor (ISO). */
  lastFeedbackAt: string;
  /** How many of this doctor's visits took feedback here. */
  visits: number;
  /** The latest Has / Doesn't-have answer per product — the most recent visit wins. */
  products: { product: string; answer: ProductAvailability }[];
};

export type ListCustomer = {
  customerId: string;
  listType: PhoenixCrmListType;
  name: string;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  origin: "reference" | "new";
  referenceContactCrmId: number | null;
  /** "pending": carried over from iReports360 and not validated yet. It counts in no report. */
  status: "active" | "pending" | "dropped";
  validatedAt: string | null;
  validatedByName: string | null;
  /** What iReports360 holds on him; null for a customer the rep added himself. */
  reference: ListCustomerReference | null;
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
  /** The pharmacy pinned as this doctor's primary, or null. */
  primaryPharmacyName: string | null;
  /** The pharmacies feedback was taken from for this doctor, primary first, then most recent. */
  pharmacies: CustomerPharmacy[];
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
    brickDistanceKm: numberOrNull(row.brick_distance_km),
    areaCode: text(row.area_code),
    areaName: text(row.area_name),
    regionCode: text(row.region_code),
    regionName: text(row.region_name),
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
  "id, customer_id, label, address, brick_id, brick_name, brick_distance_km, area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters, timings, photo_path, captured_at, device_skew_minutes";
const CUSTOMER_COLUMNS =
  "id, list_type, name, speciality, grade, origin, reference_contact_crm_id, status, validated_at, validated_by_hr_id, dropped_reason, dropped_note, status_changed_at, primary_pharmacy_name";

/**
 * Every customer carried over from the territory's iReports360 list has a row here, pending until the
 * rep validates it at the clinic. Minting them is idempotent, so every read of the list, the planner
 * or the visit form calls this and the list keeps itself in step with iReports360 — a customer added
 * there appears, one taken off simply stops being minted.
 */
export async function ensureReferenceCustomers(seat: OrgSeat, isTest: boolean): Promise<void> {
  if (!seat.lineCode) return;
  const { error } = await getSupabaseAdmin().rpc("phoenix_crm_ensure_reference_customers", {
    p_seat_id: seat.seatId,
    p_line_code: seat.lineCode,
    p_is_test: isTest,
  });
  throwIfError(error);
}

/** Every customer of a territory (on the list and dropped), with its active places. */
export async function loadTerritoryCustomers(
  seatId: string,
  isTest: boolean,
  options: { onListOnly?: boolean } = {},
): Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }> {
  const supabase = getSupabaseAdmin();
  const [customers, places] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest);
        // On the list: validated, or carried over and waiting to be. Only a dropped customer is left out.
        if (options.onListOnly) query = query.in("status", ["active", "pending"]);
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

/** The key a free-typed pharmacy name is grouped by — the same normalization the visit form suggests with. */
export function normalizePharmacyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** At most this many pharmacies are shown per doctor, most-recent first. */
const CUSTOMER_PHARMACIES_MAX = 50;

/** One visit's pharmacy feedback, as the grouping reads it. */
export type PharmacyFeedback = {
  customerId: string;
  pharmacyName: string;
  productAvailability: Record<string, ProductAvailability>;
  capturedAt: string;
};

type PharmacyAggregate = {
  name: string;
  lastFeedbackAt: string;
  visits: number;
  /** product → { answer, at } so a newer visit's answer wins per product. */
  products: Map<string, { answer: ProductAvailability; at: string }>;
};

/**
 * Group a doctor's visit feedback into his pharmacies, case-insensitively: the display name is the most
 * recent spelling, each product keeps its latest Has/Doesn't-have answer, and the list is most-recent
 * first. `isPrimary` is left false here and set by the caller, which knows the pinned primary. Pure, so
 * the grouping is tested without a database.
 */
export function groupCustomerPharmacies(feedback: PharmacyFeedback[]): Map<string, CustomerPharmacy[]> {
  // Oldest first, so a more recent visit's spelling and answers overwrite earlier ones.
  const rows = [...feedback].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));

  const byCustomer = new Map<string, Map<string, PharmacyAggregate>>();
  for (const row of rows) {
    const name = row.pharmacyName.trim();
    if (!name) continue;
    const key = normalizePharmacyName(name);
    let pharmacies = byCustomer.get(row.customerId);
    if (!pharmacies) {
      pharmacies = new Map();
      byCustomer.set(row.customerId, pharmacies);
    }
    const aggregate = pharmacies.get(key) ?? { name, lastFeedbackAt: row.capturedAt, visits: 0, products: new Map() };
    aggregate.name = name;
    aggregate.lastFeedbackAt = row.capturedAt;
    aggregate.visits += 1;
    for (const [product, answer] of Object.entries(row.productAvailability)) {
      aggregate.products.set(product, { answer, at: row.capturedAt });
    }
    pharmacies.set(key, aggregate);
  }

  const result = new Map<string, CustomerPharmacy[]>();
  for (const [customerId, pharmacies] of byCustomer) {
    const list: CustomerPharmacy[] = [...pharmacies.values()]
      .map((aggregate) => ({
        name: aggregate.name,
        isPrimary: false,
        lastFeedbackAt: aggregate.lastFeedbackAt,
        visits: aggregate.visits,
        products: [...aggregate.products.entries()]
          .map(([product, latest]) => ({ product, answer: latest.answer }))
          .sort((left, right) => left.product.localeCompare(right.product)),
      }))
      .sort((left, right) => right.lastFeedbackAt.localeCompare(left.lastFeedbackAt))
      .slice(0, CUSTOMER_PHARMACIES_MAX);
    result.set(customerId, list);
  }
  return result;
}

/** The pharmacies each doctor's feedback came from, from this territory's visits. */
export async function loadCustomerPharmacies(seatId: string, isTest: boolean): Promise<Map<string, CustomerPharmacy[]>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, pharmacy_name, product_availability, captured_at")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .not("pharmacy_name", "is", null),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const feedback: PharmacyFeedback[] = [];
  for (const row of rows) {
    const name = text(row.pharmacy_name);
    if (!name) continue;
    feedback.push({
      customerId: String(row.customer_id),
      pharmacyName: name,
      productAvailability: parseProductAvailability(row.product_availability),
      capturedAt: String(row.captured_at),
    });
  }
  return groupCustomerPharmacies(feedback);
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

/**
 * Real readiness for many territories in one call. With markReady, a complete territory is stamped ready once.
 * The answer holds every territory asked about, or the call throws: a territory the database did not
 * answer for is never read as ready (or as anything else).
 */
export async function loadReadiness(seatIds: string[], markReady = false): Promise<Map<string, SeatReadiness>> {
  const readiness = new Map<string, SeatReadiness>();
  const asked = [...new Set(seatIds)];
  for (const part of chunk(asked, 150)) {
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
        // A territory with no reference list is ready but never stamped, so a list that reaches it later
        // (a new rep's first iReports360 list) is finished before planning.
        ready: Boolean(text(row.ready_at)) || (open === 0 && dropPending === 0),
        readyAt: text(row.ready_at),
      });
    }
  }
  const unanswered = asked.filter((seatId) => !readiness.has(seatId));
  if (unanswered.length > 0) {
    throw new Error(`phoenix_crm_seat_readiness answered no row for ${unanswered.length} of ${asked.length} territories`);
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
  await ensureReferenceCustomers(seat, isTest);
  const [reference, { customers, placesByCustomer }, requestRows, visitCounts, pharmaciesByCustomer, readinessMap] = await Promise.all([
    loadReference(seat.seatId, isTest),
    loadTerritoryCustomers(seat.seatId, isTest),
    loadRequestRows([seat.seatId], isTest),
    loadMonthVisitCounts(seat.seatId, isTest, monthStart, viewer.cairoToday),
    loadCustomerPharmacies(seat.seatId, isTest),
    isTest ? Promise.resolve(null) : loadReadiness([seat.seatId]),
  ]);

  const names = await loadPeopleNames([
    ...territoryPeople(viewer.org, [seat]),
    ...requestRows.flatMap((row) => [text(row.requested_by_hr_id), text(row.decided_by_hr_id)]),
    ...customers.map((row) => text(row.validated_by_hr_id)),
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

  const referenceByContact = new Map(reference.map((row) => [Number(row.contact_crm_id), row]));

  const listCustomers: ListCustomer[] = customers.map((row) => {
    const customerId = String(row.id);
    const listType: PhoenixCrmListType = row.list_type === "AM" ? "AM" : "PM";
    const grade = parseGrade(row.grade);
    const visits = visitCounts.get(customerId) ?? 0;
    const target = gradeTarget(viewer.config.settings, listType, grade);
    const pending = pendingByCustomer.get(customerId);
    const droppedReason = text(row.dropped_reason);
    const validatedBy = text(row.validated_by_hr_id);
    const contactCrmId = numberOrNull(row.reference_contact_crm_id);
    const referenceRow = contactCrmId === null ? undefined : referenceByContact.get(contactCrmId);
    const primaryPharmacyName = text(row.primary_pharmacy_name);
    const primaryKey = primaryPharmacyName ? normalizePharmacyName(primaryPharmacyName) : null;
    const pharmacies = (pharmaciesByCustomer.get(customerId) ?? [])
      .map((pharmacy) => ({ ...pharmacy, isPrimary: primaryKey !== null && normalizePharmacyName(pharmacy.name) === primaryKey }))
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || right.lastFeedbackAt.localeCompare(left.lastFeedbackAt));
    return {
      customerId,
      listType,
      name: String(row.name),
      speciality: text(row.speciality),
      grade,
      origin: row.origin === "new" ? "new" : "reference",
      referenceContactCrmId: contactCrmId,
      status: row.status === "dropped" ? "dropped" : row.status === "pending" ? "pending" : "active",
      validatedAt: text(row.validated_at),
      validatedByName: validatedBy ? nameOf(names, validatedBy) : null,
      reference: referenceRow
        ? { address: referenceRow.address, city: referenceRow.city, zone: referenceRow.zone, lastVisitedOn: referenceRow.last_visited_on }
        : null,
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
      primaryPharmacyName,
      pharmacies,
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

/**
 * The place as the database function reads it — the whole location resolved HERE, from the captured
 * coordinates, and never taken from the phone.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to brick
 * area region clean addresss and raw location". Five things, and each is written once:
 *
 *   - **raw location** — `lat`, `lon`, `accuracy_meters`, and the phone's clock compared with ours;
 *     the coordinates the camera reported, untouched;
 *   - **clean address** — Google's own formatted address for that point, read here through the same
 *     `resolveEvidenceLocation` the photo's watermark uses, so the address ON the picture and the
 *     address in the row are one lookup and cannot disagree;
 *   - **brick**, **area**, **region** — the Phoenix territory the point physically fell in, from the
 *     nearest brick centroid, with the distance that justifies it kept beside them. A match further
 *     than `BRICK_TRUST_KM` names no brick at all rather than a fabricated neighbouring one, and the
 *     distance is stored either way: a wrong brick is only ever visible in that number.
 *
 * Before this the phone sent `address`, `zone` and `brick` and the row took them as given, so the
 * evidence of where a customer is could be typed over on the way. It cannot now: `PlaceDraft` no
 * longer carries them, and nothing on this path reads the body for a location.
 */
async function placePayload(place: PlaceDraft): Promise<Row> {
  const [centroids, issuedAt, located] = await Promise.all([
    loadBrickCentroids(),
    photoSlotIssuedAt(place.photoPath),
    // Best-effort, exactly as the watermark treats it: a pin in the desert, a refused lookup or a
    // spent map quota leaves the clean address null. The coordinates, the photo and the brick are
    // the proof; the address is the courtesy on top of them, and a validation is never blocked on it.
    resolveEvidenceLocation({ accuracyMeters: place.accuracyMeters, latitude: place.lat, longitude: place.lon }).catch(() => null),
  ]);
  const brick = resolveBrickForPoint(place.lat, place.lon, centroids);
  const trusted = brick && brick.distanceKm <= BRICK_TRUST_KM ? brick : null;
  return {
    photo_path: place.photoPath,
    lat: place.lat,
    lon: place.lon,
    accuracy_meters: place.accuracyMeters,
    device_skew_minutes: issuedAt ? deviceClockSkewMinutes(place.deviceCapturedAt, new Date(issuedAt)) : null,
    label: place.label,
    address: located?.address ?? null,
    zone: located?.components.area ?? null,
    brick_id: trusted?.brickId ?? null,
    brick_name: trusted?.brickName ?? null,
    brick_distance_km: brick ? Math.round(brick.distanceKm * 100) / 100 : null,
    area_code: trusted?.areaCode ?? null,
    area_name: trusted?.areaName ?? null,
    region_code: trusted?.regionCode ?? null,
    region_name: trusted?.regionName ?? null,
    timings: place.timings,
  };
}

/**
 * Judge the position a place was captured at, once the place is safely on file.
 *
 * Separate from `placePayload` on purpose: that function builds what gets SAVED, and nothing about
 * this check may ever influence that. This runs afterwards, writes only to the private integrity
 * table, returns nothing and throws nothing — a rep validating a customer sees no difference at all.
 */
async function judgeCaptureForPlace(
  viewer: PhoenixCrmViewer,
  seatId: string,
  isTest: boolean,
  placeId: string,
  customerId: string,
  capturedAtText: string,
  place: PlaceDraft,
): Promise<void> {
  const capturedAt = new Date(capturedAtText);
  if (Number.isNaN(capturedAt.getTime())) return;
  await judgeCapture({
    subjectKind: "place",
    subjectId: placeId,
    seatId,
    repHrId: viewer.hrId,
    customerId,
    isTest,
    fix: { lat: place.lat, lon: place.lon, accuracyMeters: place.accuracyMeters, capturedAt },
    deviceMocked: place.deviceMocked,
  });
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
  // A validated place is the reference point every later visit to this customer is measured against,
  // so a spoof here is worth more to a cheat than a spoofed visit — one fake pin makes a year of
  // visits read "ok". Judged after the save, silently, exactly as a visit is.
  await judgeCaptureForPlace(viewer, seat.seatId, isTest, validated.placeId, validated.customerId, validated.capturedAt, place.value);
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

/**
 * The customer's name and speciality, changed later.
 *
 * Owner, 2026-09-22: validating is the three captures and nothing else — "later can change his name,
 * can change his grade". The grade keeps its proposal flow (the district manager decides it, because it
 * sets the rep's own target); the name and speciality are the rep's own to correct. The territory's rep
 * only, and never on a customer that has left the list.
 */
export async function renameCustomer(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; customerName: string; speciality: string | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to change.");
  const name = cleanText(body.name, CUSTOMER_NAME_MAX);
  if (!name || name.length < 3) throw validationError("Write the customer's full name.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_rename_customer", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      name,
      speciality: cleanText(body.speciality, 80),
      allow_same_name: body.allowSameName === true,
    },
  });
  return { customerId: String(result.customer_id), customerName: String(result.customer_name), speciality: text(result.speciality) };
}

/**
 * Pin one pharmacy as this doctor's primary, or clear it (an empty name clears). The name is a
 * free-text pharmacy the rep chose from the ones his feedback already named; the territory's rep only,
 * and never on a customer that has left the list.
 */
export async function setPrimaryPharmacy(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; primaryPharmacyName: string | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to change.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_set_primary_pharmacy", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      pharmacy_name: cleanText(body.pharmacyName, PHARMACY_NAME_MAX),
    },
  });
  return { customerId: String(result.customer_id), primaryPharmacyName: text(result.primary_pharmacy_name) };
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
  const added = { placeId: String(result.place_id), customerId: String(result.customer_id), customerName: String(result.customer_name) };
  // A second place is a second reference point, judged exactly as the first one is.
  const issuedAt = await photoSlotIssuedAt(place.value.photoPath).catch(() => null);
  if (issuedAt) await judgeCaptureForPlace(viewer, seat.seatId, isTest, added.placeId, added.customerId, issuedAt, place.value);
  return added;
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
    // An edit changes what the rep WROTE — the place's name and its days and hours. It never reaches
    // the location: the clean address, the part of town, the brick, the area and the region were
    // resolved from the captured coordinates and are the customer's record now (owner, 2026-09-23).
    // They are not read from the body and not passed back through, so `phoenix_crm_update_place` has
    // nothing to write them from even if an older phone still sends them.
    Object.assign(payload, {
      timings: timings.timings,
      label: cleanText(body.label, PLACE_TEXT_MAX),
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
