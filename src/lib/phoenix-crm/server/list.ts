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
 * Owner, 2026-09-29 — the rep's flow rebuilt (src/lib/phoenix-crm/list-request-rules.ts holds the
 * customer's whole life on the list):
 *   - a place is validated ONCE, with two readings — the Capture-location pin and the photo's own
 *     shutter reading. The photo's reading is the fixed point; the pin is the fallback. Only the Super
 *     Admin and the SFE Manager move a place, with a written reason (place-move.ts);
 *   - a customer met outside the list is validated at the door and WAITS outside it; adding him, dropping
 *     a listed one and bringing one back from the Archive go to the district manager, then SFE. The
 *     manager confirms the A/B/C grade of an add and sets its potential (AA..BC, shown only);
 *   - a customer's earlier visits are measured against his place once he has one (visit-locations.ts).
 *
 * Every write goes through one database function that re-checks the rule under a per-territory lock
 * (supabase/migrations/20260916150000_phoenix_crm.sql); this file checks who may ask, shapes the entry
 * and tells the people who must act.
 */

import { loadBrickCentroids, loadBrickNames, resolveBrickForPoint } from "@/lib/crm/brick-geo";
// The iReports360 mirror, reached from inside this walled module exactly as brick-from-coordinates
// is: the sharing question can only be answered against the WHOLE company's contact roster, which
// Phoenix CRM's own tables do not hold.
import type { SharedWith } from "@/lib/crm/location-confidence";
import { loadObservedPointsFor, loadSharedCustomersFor } from "@/lib/crm/shared-customers";
import { logError } from "@/lib/observability/log";
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
  parseOutsideCustomer,
  parsePlaceDraft,
  parsePotentialGrade,
  parseProductAvailability,
  PHARMACY_NAME_MAX,
  PLACE_TEXT_MAX,
  placePoint,
  type PlaceDraft,
  type PotentialGrade,
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import {
  archiveReasonLabel,
  firstRequestStage,
  isRequestStage,
  listSectionOf,
  requestKindLabel,
  requestStageLabel,
  type ListSection,
} from "@/lib/phoenix-crm/list-request-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  assertListRequestApprover,
  assertPlaceMover,
  canDecideListRequest,
  canMovePlaces,
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
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import type { PlannerReference } from "@/lib/phoenix-crm/suggestions";
import { parseTimings, sortTimings } from "@/lib/phoenix-crm/timings";
import type {
  PhoenixCrmCustomerStatus,
  PhoenixCrmGrade,
  PhoenixCrmListType,
  PhoenixCrmRequestKind,
  PhoenixCrmRequestStage,
  PhoenixCrmRequestStatus,
  PhoenixCrmTiming,
} from "@/lib/phoenix-crm/types";
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

function customerStatusOf(value: unknown): PhoenixCrmCustomerStatus {
  return value === "pending" || value === "outside" || value === "dropped" ? value : "active";
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
  /** The FIXED point every later visit is measured against: the photo's reading, else the pin. */
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  timings: PhoenixCrmTiming[];
  photoPath: string;
  capturedAt: string;
  /** The phone's clock was more than 15 minutes off the server's when the photo was taken. */
  clockOff: boolean;
  /**
   * Where the fixed point came from (owner, 2026-09-29): the photo's own shutter reading, the
   * Capture-location pin when the photo had none, or a move by the Super Admin or the SFE Manager.
   */
  pointSource: "photo" | "pin" | "moved";
  /** The two raw readings, kept beside the fixed point for good. Null where one was not measured. */
  pinReading: PlaceReading | null;
  photoReading: PlaceReading | null;
  /** Set once the place was moved: when, and the written reason. */
  moved: { at: string; reason: string | null } | null;
};

export type PlaceReading = { lat: number; lon: number; accuracyMeters: number | null };

/** What iReports360 said about a carried-over customer, so the rep can find him before he has a place. */
export type ListCustomerReference = {
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
  /**
   * The brick this customer already sits in, carried over from iReports360 — the "known brick" a
   * pending customer belongs to BEFORE he is captured. Owner, 2026-09-26: a pending customer is
   * grouped under this brick rather than an amber "locality not yet mapped" heading, because he does
   * have a territory — it just has not been confirmed on the spot yet. Null only when iReports360
   * has no brick for him (in production every carried-over customer has one). The RPC gives the brick
   * id only; `brickName` and `areaName` are resolved from the Source-of-Sales master through
   * `loadBrickNames` in `@/lib/crm/brick-geo` — that reach lives outside this walled module, exactly
   * as brick-from-coordinates does. The owner's rule is that a screen shows names, never the code, so
   * `brickName` is what the heading uses.
   */
  brickId: string | null;
  brickName: string | null;
  areaName: string | null;
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
  /**
   * "pending": carried over from iReports360 and not validated yet. It counts in no report.
   * "outside": met outside the list and validated at the door, waiting to be added (2026-09-29).
   * "dropped": in the Archive.
   */
  status: PhoenixCrmCustomerStatus;
  /** Which section of the List he sits in — the one place that decision is made (list-request-rules.ts). */
  section: ListSection;
  /**
   * The district manager's read of his potential, set when he approved adding him. Shown only: every
   * frequency, target and KPI reads the A/B/C grade.
   */
  potentialGrade: PotentialGrade | null;
  /** Set once validated AND on the list; an outside customer keeps it empty until he is admitted. */
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
  /**
   * 🔴 ANOTHER REP CARRIES THIS CUSTOMER TOO (owner, 2026-09-30: "if a doctor is shared between this
   * rep and another rep, it was highlighted"). Null for the overwhelming majority.
   *
   * An INFERENCE, not a record: iReports360 gives every rep their own row for one doctor, so the
   * match is worked out from the name and the pin, or from a shared phone. The basis is printed
   * beside the highlight so a reader who disagrees can overrule it, and nothing is ever merged — a
   * two-line customer is a treasure, never a duplicate to tidy away.
   */
  sharedWith: SharedWith[] | null;
  /**
   * 🔴 WHERE THE REPS HAVE ACTUALLY STOOD in front of this doctor, averaged from iReports360's
   * check-ins on him (owner, 2026-09-30: "you will get the location of the doctor from the
   * check-ins ... and make an average"). Null when nobody has ever checked in.
   *
   * It beats the vendor's TYPED address, which on this data is a region — "Monofia III · Delta
   * West" — that cannot be driven to. It never beats a place the rep captured and confirmed at the
   * door: that is a deliberate act, this is an observation. `averageCheckinPoint` explains why the
   * average is taken over the fixes that agree with one another rather than over all of them.
   */
  observed: { lat: number; lon: number; address: string | null; at: string | null; agreed: number; total: number } | null;
  pendingGradeRequestId: string | null;
  pendingGrade: PhoenixCrmGrade | null;
  pendingDropRequestId: string | null;
  /** Every request waiting on him, whatever its kind, with the step it is on. */
  waiting: Array<{ requestId: string; kind: PhoenixCrmRequestKind; stage: PhoenixCrmRequestStage | null; stageLabel: string | null }>;
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
  /** "Add to the list", "Drop from the list"… */
  kindLabel: string;
  /** The step a waiting drop, add or bring-back is on; null for a grade change and once decided. */
  stage: PhoenixCrmRequestStage | null;
  stageLabel: string | null;
  /** An add, once the district manager approved it: the A/B/C he confirmed and the potential he set. */
  approvedGrade: PhoenixCrmGrade | null;
  potentialGrade: PotentialGrade | null;
  /** The district manager's step of a two-step request, once taken. */
  managerDecision: { byName: string; at: string; note: string | null } | null;
  /** The viewer decides the step this request is on (the caller sets it; the mapper cannot know). */
  canDecide: boolean;
};

export type TerritoryListView = {
  territory: TerritorySummary;
  isTest: boolean;
  /** The viewer is the territory's rep (or the Super Admin in test mode): the list can be changed. */
  canEdit: boolean;
  /** The viewer decides this territory's requests. */
  canReview: boolean;
  /** The viewer may move a validated place: the Super Admin and the SFE Manager, nobody else. */
  canMovePlaces: boolean;
  /**
   * The viewer decides the SFE step, so he may bring an archived customer back himself (the SFE manages
   * the Archive, owner 2026-09-29): the SFE Manager in scope, the Super Admin in test mode.
   */
  canBringBack: boolean;
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
    pointSource: row.point_source === "photo" || row.point_source === "moved" ? row.point_source : "pin",
    pinReading: readingOf(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
    photoReading: readingOf(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
    moved: text(row.moved_at) ? { at: String(row.moved_at), reason: text(row.move_reason) } : null,
  };
}

function readingOf(lat: unknown, lon: unknown, accuracy: unknown): PlaceReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

const PLACE_COLUMNS =
  "id, customer_id, label, address, brick_id, brick_name, brick_distance_km, area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters, timings, photo_path, captured_at, device_skew_minutes, " +
  "pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, point_source, moved_at, move_reason";
const CUSTOMER_COLUMNS =
  "id, list_type, name, speciality, grade, potential_grade, origin, reference_contact_crm_id, status, validated_at, validated_by_hr_id, dropped_reason, dropped_note, status_changed_at, primary_pharmacy_name";

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

/**
 * Every customer of a territory (on the list, outside it and in the Archive), with its active places.
 *
 * `onListOnly` keeps the list itself: validated, or carried over and waiting to be. `includeOutside`
 * adds the customers met outside the list and waiting to be added — the visit form offers them (a
 * second out-of-list visit to the same person), the planner deliberately does not.
 */
export async function loadTerritoryCustomers(
  seatId: string,
  isTest: boolean,
  options: { onListOnly?: boolean; includeOutside?: boolean } = {},
): Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }> {
  const supabase = getSupabaseAdmin();
  const [customers, places] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).eq("seat_id", seatId).eq("is_test", isTest);
        // On the list: validated, or carried over and waiting to be. A dropped customer is left out, and
        // one waiting outside the list only when the caller asks for him.
        if (options.onListOnly) query = query.in("status", options.includeOutside ? ["active", "pending", "outside"] : ["active", "pending"]);
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

/**
 * Visits a customer this month, by customer id.
 *
 * `phoenix_crm_countable_visits`, never the base table. This read feeds `visitsThisMonth` — the rep's
 * own standing against his grade norm on FOUR screens (the visit form, the weekly planner, the monthly
 * planner and the List board) and, through `coverageTier`, the day's suggestions. It is a PostgREST
 * read and not one of the phoenix_crm_report_* functions, so "I moved every report to the view" does
 * not reach it; leave it on the raw table and an off-plan visit nobody has approved quietly satisfies
 * a frequency norm everywhere a rep plans.
 */
export async function loadMonthVisitCounts(seatId: string, isTest: boolean, monthStart: string, through: string): Promise<Map<string, number>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_countable_visits")
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

/**
 * Where each customer NOT VALIDATED YET among `customers` sits, keyed by customer id — what the plan
 * board shows in the place a validated customer's clinic would fill (owner, 2026-09-30).
 *
 * The brick and its area come from `loadBrickNames`, i.e. the sales master, which agrees with the
 * organogram on every area name. iReports360's own `zone` and `city` are NOT read: they are a different
 * vocabulary that disagrees with the organogram on 37 of 39 areas (see `PlannerReference`). Only its
 * `address` — the town — is carried over.
 */
export async function loadPlannerReferences(seatId: string, isTest: boolean, customers: ReadonlyArray<Row>): Promise<Map<string, PlannerReference>> {
  const pending = customers.filter((row) => row.status === "pending" && numberOrNull(row.reference_contact_crm_id) !== null);
  const references = new Map<string, PlannerReference>();
  if (pending.length === 0) return references;
  const reference = await loadReference(seatId, isTest);
  const byContact = new Map(reference.map((row) => [Number(row.contact_crm_id), row]));
  const brickMeta = await loadBrickNames(reference.map((row) => row.brick_id).filter((brickId): brickId is string => Boolean(brickId)));
  for (const row of pending) {
    const entry = byContact.get(Number(row.reference_contact_crm_id));
    if (!entry) continue;
    const meta = entry.brick_id ? brickMeta.get(entry.brick_id) : undefined;
    references.set(String(row.id), { brick: meta?.brickName ?? null, area: meta?.areaName ?? null, address: entry.address });
  }
  return references;
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

function requestKindOf(value: unknown): PhoenixCrmRequestKind {
  return value === "drop" || value === "add" || value === "restore" ? value : "grade";
}

/** The people a request row names, for one names read. */
export function requestPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [text(row.requested_by_hr_id), text(row.decided_by_hr_id), text(row.manager_decided_by_hr_id)]);
}

export function mapRequestRow(row: Row, names: ReadonlyMap<string, string>): ListRequest {
  const dropReason = text(row.drop_reason);
  const kind = requestKindOf(row.kind);
  const status = String(row.status) as PhoenixCrmRequestStatus;
  const stage = status === "pending" && isRequestStage(row.stage) ? row.stage : null;
  const managerBy = text(row.manager_decided_by_hr_id);
  return {
    requestId: String(row.id),
    kind,
    status,
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
    kindLabel: requestKindLabel(kind),
    stage,
    stageLabel: requestStageLabel(stage),
    approvedGrade: parseGrade(row.approved_grade),
    potentialGrade: parsePotentialGrade(row.potential_grade),
    managerDecision:
      managerBy && text(row.manager_decided_at)
        ? { byName: nameOf(names, managerBy), at: String(row.manager_decided_at), note: text(row.manager_note) }
        : null,
    canDecide: false,
  };
}

const REQUEST_COLUMNS =
  "id, seat_id, kind, status, stage, customer_id, reference_contact_crm_id, customer_name, list_type, current_grade, proposed_grade, " +
  "approved_grade, potential_grade, drop_reason, note, requested_by_hr_id, requested_at, manager_decided_by_hr_id, manager_decided_at, " +
  "manager_note, decided_by_hr_id, decided_at, decision_note, is_test";

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
    ...requestPeople(requestRows),
    ...customers.map((row) => text(row.validated_by_hr_id)),
    reference[0]?.source_hr_id ?? null,
  ]);
  const requests = requestRows.map((row) => {
    const request = mapRequestRow(row, names);
    return { ...request, canDecide: request.status === "pending" && canDecideListRequest(viewer, seat, isTest, request.stage) };
  });
  const pendingByCustomer = new Map<string, Partial<Record<PhoenixCrmRequestKind, ListRequest>>>();
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
  // The name and area of every brick iReports360 carries a reference customer in — so a pending
  // customer groups under his known brick rather than an amber "not yet mapped" heading.
  const referenceBrickMeta = await loadBrickNames(
    reference.map((row) => row.brick_id).filter((brickId): brickId is string => Boolean(brickId)),
  );

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
    const status = customerStatusOf(row.status);
    const origin = row.origin === "new" ? "new" : "reference";
    const validatedAt = text(row.validated_at);
    return {
      customerId,
      listType,
      name: String(row.name),
      speciality: text(row.speciality),
      grade,
      origin,
      referenceContactCrmId: contactCrmId,
      status,
      section: listSectionOf({ status, origin, validatedAt }),
      potentialGrade: parsePotentialGrade(row.potential_grade),
      validatedAt,
      validatedByName: validatedBy ? nameOf(names, validatedBy) : null,
      reference: referenceRow
        ? {
            address: referenceRow.address,
            city: referenceRow.city,
            zone: referenceRow.zone,
            lastVisitedOn: referenceRow.last_visited_on,
            brickId: referenceRow.brick_id,
            brickName: referenceRow.brick_id ? (referenceBrickMeta.get(referenceRow.brick_id)?.brickName ?? null) : null,
            areaName: referenceRow.brick_id ? (referenceBrickMeta.get(referenceRow.brick_id)?.areaName ?? null) : null,
          }
        : null,
      droppedReason: archiveReasonLabel(droppedReason) ?? dropReasonLabel(droppedReason) ?? droppedReason,
      droppedNote: text(row.dropped_note),
      statusChangedAt: String(row.status_changed_at),
      places: placesByCustomer.get(customerId) ?? [],
      visitsThisMonth: visits,
      target,
      tier: coverageTier(visits, target),
      pendingGradeRequestId: pending?.grade?.requestId ?? null,
      pendingGrade: pending?.grade?.proposedGrade ?? null,
      pendingDropRequestId: pending?.drop?.requestId ?? null,
      waiting: Object.values(pending ?? {}).map((request) => ({
        requestId: request.requestId,
        kind: request.kind,
        stage: request.stage,
        stageLabel: request.stageLabel,
      })),
      primaryPharmacyName,
      pharmacies,
      sharedWith: null,
      observed: null,
    };
  });
  listCustomers.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  // 🔴 WHO ELSE CARRIES THESE CUSTOMERS (owner, 2026-09-30: "if a doctor is shared between this rep
  // and another rep, it was highlighted"). Answered against the iReports360 roster, because only a
  // company-wide read can see the other rep's row — Phoenix CRM's own tables hold one territory.
  //
  // It NEVER takes the List down with it. A vacant territory has no rep to compare against, a test
  // world has no iReports360 rows at all, and the mirror can be missing entirely on a fresh
  // environment; every one of those is an ordinary answer of "nobody", not a failure to report. A
  // highlight is a nicety; the list itself is the page.
  const sharedKeys = listCustomers
    .map((customer) => customer.referenceContactCrmId)
    .filter((id): id is number => typeof id === "number");
  // `occupantHrId`, not `repHrId`: the seat's own field name. `loadSharedCustomersFor`'s PARAMETER is
  // called `repHrId`, which is what the seat was read as. Null here is a vacant territory, which the
  // comment above already treats as an ordinary "nobody" — so the guard is the same one either way.
  if (seat.occupantHrId && sharedKeys.length > 0 && !isTest) {
    try {
      // 🔴 AND WHERE EACH DOCTOR ACTUALLY IS, averaged from the check-ins the reps have already
      // taken on him (owner, 2026-09-30). Both questions are answered against the same mirror, so
      // they are asked together rather than one page load apart.
      const [sharedByContact, observedByContact] = await Promise.all([
        loadSharedCustomersFor(sharedKeys, seat.occupantHrId),
        loadObservedPointsFor(sharedKeys),
      ]);
      for (const customer of listCustomers) {
        if (customer.referenceContactCrmId === null) continue;
        const shared = sharedByContact.get(customer.referenceContactCrmId) ?? null;
        customer.sharedWith = shared && shared.length > 0 ? shared : null;
        const point = observedByContact.get(customer.referenceContactCrmId) ?? null;
        customer.observed = point ? { address: point.address, at: point.at, agreed: point.agreed, lat: point.lat, lon: point.lon, total: point.total } : null;
      }
    } catch (error) {
      logError("Phoenix CRM list: the shared-customer and check-in reads could not run", {
        error,
        labels: { event: "phoenix_crm_shared_customers_failed" },
      });
    }
  }

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
    canMovePlaces: canMovePlaces(viewer, seat, isTest),
    canBringBack: canDecideListRequest(viewer, seat, isTest, "sfe"),
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
 *
 * Owner, 2026-09-29: the place is captured with TWO readings — the Capture-location pin and the
 * photo's own shutter reading — and "the photo + the location of photo is the more trustable". So
 * the location above is resolved from `placePoint` (the photo's reading, else the pin), `lat`/`lon`
 * hold that fixed point, and both raw readings are stored beside it for good.
 */
async function placePayload(place: PlaceDraft): Promise<Row> {
  const point = placePoint(place);
  const [issuedAt, located] = await Promise.all([photoSlotIssuedAt(place.photoPath), resolvePlaceLocation(point)]);
  return {
    photo_path: place.photoPath,
    lat: point.lat,
    lon: point.lon,
    accuracy_meters: point.accuracyMeters,
    point_source: point.source,
    pin_lat: place.lat,
    pin_lon: place.lon,
    pin_accuracy_meters: place.accuracyMeters,
    photo_lat: place.photoLat,
    photo_lon: place.photoLon,
    photo_accuracy_meters: place.photoAccuracyMeters,
    photo_captured_at: place.photoCapturedAt,
    device_skew_minutes: issuedAt ? deviceClockSkewMinutes(place.deviceCapturedAt, new Date(issuedAt)) : null,
    label: place.label,
    ...located,
    timings: place.timings,
  };
}

/**
 * A point's clean address, part of town, brick, area and region — the location every place row holds,
 * resolved here and nowhere else (a validation and a move read the same function, so they can never
 * disagree about which brick a point is in).
 */
export async function resolvePlaceLocation(point: { lat: number; lon: number; accuracyMeters: number | null }): Promise<Row> {
  const [centroids, located] = await Promise.all([
    loadBrickCentroids(),
    // Best-effort, exactly as the watermark treats it: a pin in the desert, a refused lookup or a
    // spent map quota leaves the clean address null. The coordinates, the photo and the brick are
    // the proof; the address is the courtesy on top of them, and a validation is never blocked on it.
    resolveEvidenceLocation({ accuracyMeters: point.accuracyMeters, latitude: point.lat, longitude: point.lon }).catch(() => null),
  ]);
  const brick = resolveBrickForPoint(point.lat, point.lon, centroids);
  const trusted = brick && brick.distanceKm <= BRICK_TRUST_KM ? brick : null;
  return {
    address: located?.address ?? null,
    zone: located?.components.area ?? null,
    brick_id: trusted?.brickId ?? null,
    brick_name: trusted?.brickName ?? null,
    brick_distance_km: brick ? Math.round(brick.distanceKm * 100) / 100 : null,
    area_code: trusted?.areaCode ?? null,
    area_name: trusted?.areaName ?? null,
    region_code: trusted?.regionCode ?? null,
    region_name: trusted?.regionName ?? null,
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
  /** Kept for a caller one release behind: the request a new customer raised. Same as `requestId`. */
  gradeRequestId: string | null;
  /** Where the customer stands now: on the list, or waiting outside it. */
  status: PhoenixCrmCustomerStatus;
  /** The request this validation raised — an add for "Add new customer", a bring-back — if any. */
  requestId: string | null;
  requestKind: PhoenixCrmRequestKind | null;
};

/**
 * Validate a customer at the door: a live signboard photo, the two location readings and his days and
 * hours, once and for good. Four modes:
 *
 *   reference — a customer carried over from iReports360 goes on the list (refused for one in the Archive);
 *   new       — "Add new customer": he waits outside the list, and the add request (district manager
 *               with the A/B/C grade and the potential, then SFE) is filed at once;
 *   outside   — met on an out-of-list visit: he waits outside the list and the rep chooses later —
 *               "Request to add" or "Drop";
 *   restore   — kept for a caller that still sends a fresh place with "Bring back": the place is kept
 *               and the bring-back request is filed.
 */
export async function validateCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<ValidateResult> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const place = parsePlaceDraft(body.place);
  if (!place.ok) throw validationError(place.error);

  const payload: Row = {
    seat_id: seat.seatId,
    line_code: lineCode,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    // Where a two-step request starts is read from the organogram, never from the phone: a territory
    // with no manager seat above it begins at SFE, as an off-plan visit's approval does.
    first_stage: firstRequestStage(territoryReviewer(viewer.org, seat.seatId) !== null),
  };
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
  } else if (mode === "outside") {
    const draft = parseOutsideCustomer(body.customer);
    if (!draft.ok) throw validationError(draft.error);
    Object.assign(payload, {
      mode: "outside",
      name: draft.value.name,
      list_type: draft.value.listType,
      speciality: draft.value.speciality,
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
  const requestKind = text(result.request_kind);
  const validated: ValidateResult = {
    customerId: String(result.customer_id),
    customerName: String(result.customer_name),
    listType: result.list_type === "AM" ? "AM" : "PM",
    placeId: String(result.place_id),
    capturedAt: String(result.captured_at),
    restored: result.restored === true,
    gradeRequestId: text(result.grade_request_id),
    status: customerStatusOf(result.status),
    requestId: text(result.request_id),
    requestKind: requestKind ? requestKindOf(requestKind) : null,
  };
  // A validated place is the reference point every later visit to this customer is measured against,
  // so a spoof here is worth more to a cheat than a spoofed visit — one fake pin makes a year of
  // visits read "ok". Judged after the save, silently, exactly as a visit is.
  await judgeCaptureForPlace(viewer, seat.seatId, isTest, validated.placeId, validated.customerId, validated.capturedAt, place.value);
  // His visits from before he had a place get their distance now (owner, 2026-09-29). Never the rep's
  // to see; the managers' place-vs-actual report reads it.
  await restampVisitLocationsQuietly({
    seatId: seat.seatId,
    isTest,
    customerId: validated.customerId,
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "unplaced",
  });
  if (validated.requestId && validated.requestKind) {
    await notifyRequestRaised(viewer, seat, isTest, {
      requestId: validated.requestId,
      requestKind: validated.requestKind,
      stage: payload.first_stage as PhoenixCrmRequestStage,
      customerName: validated.customerName,
      listType: validated.listType,
      proposedGrade,
      dropReason: null,
    });
  }
  return validated;
}

/**
 * Tell the district manager a request is waiting for him. The SFE step has no push of its own — the
 * SFE Manager holds no seat to address — and shows through the Team tab's counter instead.
 */
async function notifyRequestRaised(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  request: {
    requestId: string;
    requestKind: PhoenixCrmRequestKind;
    stage: PhoenixCrmRequestStage | null;
    customerName: string;
    listType: PhoenixCrmListType;
    proposedGrade: PhoenixCrmGrade | null;
    dropReason: string | null;
  },
): Promise<void> {
  if (request.stage === "sfe") return;
  await notifyPhoenixCrm(
    {
      kind: "request_created",
      org: viewer.org,
      seat,
      requestId: request.requestId,
      requestKind: request.requestKind,
      requesterHrId: viewer.hrId,
      customerName: request.customerName,
      listType: request.listType,
      proposedGrade: request.proposedGrade,
      dropReason: request.dropReason,
    },
    isTest,
  );
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

/**
 * Editing a place's timings and details (no new photo: the change is kept in the events), or removing it.
 *
 * The rep edits his customer's days and hours and the place's name. REMOVING a place is a change of
 * where the customer is, so since 2026-09-29 it is the Super Admin's and the SFE Manager's alone,
 * exactly as moving one is ("the location never changes — only the system administrator").
 */
export async function updatePlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; customerId: string }> {
  const body = record(raw);
  if (!isUuid(body.placeId)) throw validationError("Choose the place to change.");
  const placeId = String(body.placeId).toLowerCase();
  const action = body.action === "retire" ? "retire" : body.action === "edit" ? "edit" : null;
  if (!action) throw validationError("Reload the page and try again.");
  let access: { seat: OrgSeat; isTest: boolean };
  if (action === "retire") {
    access = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
    assertPlaceMover(viewer, access.seat, access.isTest);
  } else {
    access = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  }
  const { seat, isTest } = access;

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

/**
 * The rep asks: a grade change (the district manager alone), or — the district manager, then SFE —
 * to drop a listed customer, to add one waiting outside the list, or to bring one back from the Archive.
 */
export async function createListRequest(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; kind: PhoenixCrmRequestKind; stage: PhoenixCrmRequestStage | null }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const lineCode = lineCodeOf(seat);
  const kind: PhoenixCrmRequestKind | null =
    body.kind === "grade" || body.kind === "drop" || body.kind === "add" || body.kind === "restore" ? (body.kind as PhoenixCrmRequestKind) : null;
  if (!kind) throw validationError("Reload the page and try again.");
  const customerId = isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null;
  const contact = Number(body.referenceContactCrmId);
  const referenceContactCrmId = !customerId && kind === "drop" && Number.isSafeInteger(contact) && contact > 0 ? contact : null;
  if (!customerId && referenceContactCrmId === null) throw validationError("Choose the customer this request is for.");

  const payload: Row = {
    seat_id: seat.seatId,
    line_code: lineCode,
    actor_hr_id: viewer.hrId,
    is_test: isTest,
    kind,
    customer_id: customerId,
    reference_contact_crm_id: referenceContactCrmId,
    first_stage: firstRequestStage(territoryReviewer(viewer.org, seat.seatId) !== null),
  };
  let proposedGrade: PhoenixCrmGrade | null = null;
  let dropReason: string | null = null;
  if (kind === "grade" || kind === "add") {
    proposedGrade = parseGrade(body.proposedGrade);
    if (!proposedGrade) throw validationError("Choose the grade you propose (A, B or C).");
    payload.proposed_grade = proposedGrade;
  } else if (kind === "drop") {
    const drop = parseDropDraft(body);
    if (!drop.ok) throw validationError(drop.error);
    dropReason = drop.value.reason;
    payload.drop_reason = drop.value.reason;
    payload.note = drop.value.note;
  } else {
    payload.note = cleanText(body.note, 500);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_create_request", { p: payload });
  const requestId = String(result.request_id);
  const stage = isRequestStage(result.stage) ? result.stage : null;
  await notifyRequestRaised(viewer, seat, isTest, {
    requestId,
    requestKind: kind,
    stage,
    customerName: String(result.customer_name),
    listType: result.list_type === "AM" ? "AM" : "PM",
    proposedGrade,
    dropReason,
  });
  return { requestId, kind, stage };
}

/**
 * The rep drops a customer he met outside his list instead of asking to add him — no approval: the
 * customer was never on the list, so nothing leaves it. He goes to the Archive, and the visits made to
 * him never count.
 */
export async function archiveOutsideCustomer(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ customerId: string; customerName: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to drop.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_archive_outside", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      customer_id: String(body.customerId).toLowerCase(),
      note: cleanText(body.note, 500),
    },
  });
  return { customerId: String(result.customer_id), customerName: String(result.customer_name) };
}

/**
 * The SFE Manager manages the Archive (owner, 2026-09-29): he can bring a customer back to the list
 * himself. It is filed as a bring-back request at the SFE step and decided in the same breath, so the
 * Archive's history reads the same whoever moved the customer — a request, who decided it, and when.
 */
export async function sfeBringBack(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ requestId: string; customerId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertListRequestApprover(viewer, seat, isTest, "sfe");
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to bring back.");
  const customerId = String(body.customerId).toLowerCase();
  const note = cleanText(body.note, 500);
  const created = await callPhoenixCrm<Row>("phoenix_crm_create_request", {
    p: {
      seat_id: seat.seatId,
      line_code: lineCodeOf(seat),
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      kind: "restore",
      customer_id: customerId,
      first_stage: "sfe",
      note,
    },
  });
  const requestId = String(created.request_id);
  await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, is_test: isTest, decision: "approve", note, stage: "sfe" },
  });
  return { requestId, customerId };
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

/**
 * A decision on a list request. Refusing needs a note for the rep.
 *
 * A grade change is the district manager's alone. A drop, an add or a bring-back takes two steps — the
 * district manager, then SFE — and the step being decided is read from the ROW, never from the phone;
 * a phone that names a step only makes the database refuse if the request has already moved on (two
 * people deciding at once). At the district manager's step of an add he confirms or changes the A/B/C
 * grade and must set the customer's potential (AA..BC).
 */
export async function decideListRequest(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ requestId: string; status: "approved" | "refused" | "pending"; stage: PhoenixCrmRequestStage | null; final: boolean }> {
  const body = record(raw);
  if (!isUuid(body.requestId)) throw validationError("Choose the request to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "refuse" ? "refuse" : null;
  if (!decision) throw validationError("Choose approve or refuse.");
  const note = cleanText(body.note, 500);
  if (decision === "refuse" && !note) throw validationError("Write a note for the rep explaining why.");

  const requestId = String(body.requestId).toLowerCase();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_list_requests")
    .select("id, seat_id, is_test, kind, status, stage")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const request = data as Row | null;
  if (!request) throw notFoundError("This request is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(request.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = request.is_test === true;
  const rowStage = isRequestStage(request.stage) ? request.stage : null;
  assertListRequestApprover(viewer, seat, isTest, rowStage);

  const kind = requestKindOf(request.kind);
  const approvedGrade = kind === "add" ? parseGrade(body.approvedGrade) : null;
  const potentialGrade = kind === "add" ? parsePotentialGrade(body.potentialGrade) : null;
  if (decision === "approve" && kind === "add" && rowStage === "manager" && !potentialGrade) {
    throw validationError("Choose the customer's potential (AA to BC) before approving.");
  }
  // The step the phone saw, when it names one; otherwise the row's own — both guard the same race.
  const stage = isRequestStage(body.stage) ? body.stage : rowStage;

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_request", {
    p: {
      request_id: requestId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      decision,
      note,
      stage,
      approved_grade: approvedGrade,
      potential_grade: potentialGrade,
    },
  });
  const final = result.final !== false;
  const status = !final ? "pending" : result.status === "approved" ? "approved" : "refused";
  const requesterHrId = text(result.requested_by_hr_id);
  // The rep hears the ANSWER: a refusal at either step, or the final approval. The district manager's
  // approval of the first step is not an answer yet — the request just moves on to SFE.
  if (requesterHrId && status !== "pending") {
    await notifyPhoenixCrm(
      {
        kind: "request_decided",
        seat,
        requestId,
        requestKind: kind,
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
  return { requestId, status, stage: isRequestStage(result.stage) ? result.stage : null, final };
}
