/**
 * Phoenix CRM — the shared place: a polyclinic, medical centre, medical tower or hospital outpatient
 * suite, captured ONCE at its door, with customers seated inside it.
 *
 * Owner, 2026-10-09 (Arabic, in chat): validate the polyclinic once, then register each customer's
 * times in it, at most three a day; he uploads a photo of the timetable naming them, at each one; the
 * location is taken once, so seating needs none; and the administrator reviews the schedule after.
 *
 * WHAT IS HERE: capturing a venue (`createSharedPlace`), the rep's picker (`loadSharedPlacesFor`),
 * the venue a seating is being saved against (`sharedPlaceForSeating`) and the seated place's own
 * payload (`seatedPlacePayload`), the administrator's board (`loadSharedPlaceBoard`) and his decision
 * (`decideSharedPlace`).
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   · the SEATED place's own save — that is `validateCustomer` / `addPlace` in server/list.ts, because
 *     a seated customer is an ORDINARY place row (`shared_place_id` set, `point_source` =
 *     'shared_place') and every reader downstream already works off a place;
 *   · a GOOGLE LISTING CHECK, on the venue or on a seating. The check compares a listing against the
 *     name on the customer's LIST row at the point he was captured, and neither half holds here: a
 *     venue has no list name at all, and a seated customer's point is the building's — so a listing
 *     comparison would refuse him for being inside a polyclinic, which is the whole case this
 *     feature exists for. Owner, asked directly the same day: "even if no Google check, he must
 *     validate by a live photo and location." The live photo and both readings are the gate, and the
 *     administrator's review is the human one behind them.
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { deviceClockSkewMinutes } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readTestFlag, territoryForRead, territoryForValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { resolvePlaceLocation } from "@/lib/phoenix-crm/server/place-location";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { photoSlotIssuedAt } from "@/lib/phoenix-crm/server/photos";
import { recordRefusedReading } from "@/lib/phoenix-crm/server/refused-readings";
import { readPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import { signboardHoldRecord, signboardHoldsForReview, type PhoenixCrmSignboardCheck } from "@/lib/phoenix-crm/signboard-rules";
import {
  parseSeatedPlaceDraft,
  parseSharedPlaceDraft,
  parseSharedPlaceKind,
  SHARED_PLACE_NAME_MAX,
  sharedPlaceKindLabel,
  type SeatedPlaceDraft,
  type SharedPlaceKind,
  type SharedPlaceNamed,
} from "@/lib/phoenix-crm/shared-place-rules";
import { placePoint } from "@/lib/phoenix-crm/entry-rules";
import { parseValidationRefusalReason, VALIDATION_REASON_REQUIRED } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

/** The Super Admin, and nobody else — the same decider every place check has. */
export function canDecideSharedPlaces(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

// ── What a screen reads ─────────────────────────────────────────────────────────────────────────

/** One venue, as the rep's picker and the administrator's board both read it. */
export type SharedPlaceRow = {
  sharedPlaceId: string;
  name: string;
  kind: SharedPlaceKind;
  kindLabel: string;
  status: "active" | "held" | "retired";
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  /** Customers currently seated in it. The cap is about the DAY, not about this number. */
  seated: number;
  capturedAt: string;
  capturedAtText: string;
  photoPath: string | null;
};

function kindOf(value: unknown): SharedPlaceKind {
  // A row whose kind no longer parses is still shown, as the commonest of the four rather than hidden:
  // a venue that disappears from the picker is a rep who cannot work, and the kind is only wording.
  return parseSharedPlaceKind(value) ?? "polyclinic";
}

function statusOf(value: unknown): SharedPlaceRow["status"] {
  return value === "held" || value === "retired" ? value : "active";
}

function mapSharedPlace(row: Row, seated: number): SharedPlaceRow {
  const kind = kindOf(row.kind);
  return {
    sharedPlaceId: String(row.id),
    name: String(row.name),
    kind,
    kindLabel: sharedPlaceKindLabel(kind) ?? "Polyclinic",
    status: statusOf(row.status),
    address: text(row.address),
    brickName: text(row.brick_name),
    areaName: text(row.area_name),
    point: { lat: numberOrNull(row.lat) ?? 0, lon: numberOrNull(row.lon) ?? 0 },
    seated,
    capturedAt: String(row.captured_at),
    capturedAtText: formatPhoenixDateTime(String(row.captured_at)),
    photoPath: text(row.photo_path),
  };
}

/**
 * 🔴 ONE STRING, AND A COLUMN THAT IS NOT THERE YET FAILS THE WHOLE READ. A PostgREST select is sent
 * verbatim; a name the database does not hold answers 42703 and takes every other field down with it,
 * exactly as `PLACE_COLUMNS`' own comment records. So this list is exactly what the migration creates,
 * and the migration reaches staging and production before this file ships.
 *
 * `brick_distance_km` and `brick_lookup` are in it because `sharedPlaceForSeating` copies the venue's
 * WHOLE resolution onto the seated row: leaving them out would have seated every customer at
 * `could_not_look` while the venue beside him read `matched`.
 */
const SHARED_PLACE_COLUMNS =
  "id, seat_id, line_code, name, kind, status, address, zone, brick_id, brick_name, brick_distance_km, brick_lookup, " +
  "area_code, area_name, region_code, region_name, lat, lon, accuracy_meters, photo_path, captured_at, " +
  "created_by_hr_id, is_test";

/**
 * What the plan's refusal needs to NAME a venue: `sharedPlaceId → name and kind`.
 *
 * 🔴 IT IS ONLY FOR THE WORDING, NEVER FOR THE COUNTING. `sharedPlanCapRefusal` counts off the plan's
 * own items and names an unknown venue "Polyclinic or centre", so a read that came back short can
 * soften a sentence and can never let a fourth visit through. A retired venue is included
 * deliberately: items placed in one before it was rejected are still on the plan and still have to be
 * named.
 */
export async function loadSharedPlaceNames(
  sharedPlaceIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, SharedPlaceNamed>> {
  const named = new Map<string, SharedPlaceNamed>();
  const rows = await selectByIds<Row>("phoenix_crm_shared_places", "id, name, kind", "id", sharedPlaceIds);
  for (const row of rows) {
    named.set(String(row.id), { sharedPlaceId: String(row.id), name: String(row.name), kind: kindOf(row.kind) });
  }
  return named;
}

/**
 * Which venue each of these PLACES sits in, `placeId → sharedPlaceId`, for places seated in one.
 *
 * The plan's SEND needs exactly this and cannot get it any other way: it re-counts the whole stored
 * week (production, 2026-10-03 — the save sees only the days one payload touched), and a stored plan
 * item carries a `place_id` and nothing about the building behind it. A place in nobody's venue is
 * simply absent from the map.
 */
export async function loadSharedPlaceIdsByPlace(
  placeIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const byPlace = new Map<string, string>();
  const rows = await selectByIds<Row>("phoenix_crm_places", "id, shared_place_id", "id", placeIds);
  for (const row of rows) {
    const venue = text(row.shared_place_id);
    if (venue) byPlace.set(String(row.id), venue);
  }
  return byPlace;
}

/** How many active customers sit in each of these venues. */
async function seatedCounts(sharedPlaceIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sharedPlaceIds.length === 0) return counts;
  const rows = await selectByIds<Row>("phoenix_crm_places", "id, shared_place_id", "shared_place_id", [...sharedPlaceIds], (query) =>
    query.eq("status", "active"),
  );
  for (const row of rows) {
    const id = String(row.shared_place_id ?? "");
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The venues a rep may seat somebody in, in one territory.
 *
 * HELD ones are returned too, marked: the rep who captured it must be able to see that it is being
 * checked rather than believe his capture was lost. Seating in one is refused by the database.
 *
 * 🔴 `territoryForRead`, NOT `territoryForValidation`. The write gate refuses the Super Admin outright
 * (`superAdminHasNoFieldWrite`) and anybody without `canCreate` — correct for CAPTURING a venue, and
 * wrong for a list: it would 403 the Super Admin's own look at the screen and every manager reading a
 * territory. Capturing one is gated where it is written, below.
 *
 * 🔒 ONE SEAT, AND NEVER A SHARED POOL — the owner's own ruling, 2026-10-09, asked and answered the
 * day the venues shipped: "every polyclinic appears only to the rep validated it. No sharing." So
 * the filter below is `.eq("seat_id", …)` and must stay a single-seat equality. Two reps covering
 * one building each capture it for themselves, and that is CORRECT, not duplication to tidy away:
 * a venue carries the capturing rep's own evidence — his live signboard photo, his two readings,
 * his `created_by_hr_id` — and seating somebody on another rep's capture would put a customer's
 * place behind a photo that rep never took. Widening this to `.in("seat_id", …)`, to a territory,
 * line, area or brick, is the defect this comment exists to stop.
 * Pinned by `tests/phoenix-crm-shared-place.test.ts`.
 */
export async function loadSharedPlacesFor(viewer: PhoenixCrmViewer, raw: unknown): Promise<SharedPlaceRow[]> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_shared_places")
    .select(SHARED_PLACE_COLUMNS)
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .in("status", ["active", "held"])
    .order("name", { ascending: true });
  throwIfError(error);
  // Through `unknown` deliberately: PostgREST types a select string it cannot parse as
  // `GenericStringError[]`, which does not overlap `Row[]`, and the compiler is right to refuse the
  // direct cast. The shape is proven by `SHARED_PLACE_COLUMNS` and the mapper below, not by this cast.
  const rows = (data ?? []) as unknown as Row[];
  const counts = await seatedCounts(rows.map((row) => String(row.id)));
  return rows.map((row) => mapSharedPlace(row, counts.get(String(row.id)) ?? 0));
}

// ── Capturing one ───────────────────────────────────────────────────────────────────────────────

/**
 * Read the sign on the building, in the signboard checker's PLACE-NAME mode.
 *
 * 🔴 `judgeSignboard`'s AM BEHAVIOUR IS EXACTLY RIGHT HERE AND IS NOT A WORKAROUND. Its AM mode reads
 * the PLACE names on a sign and never a person's — which is the owner's own 2026-10-08 ruling that "a
 * hospital signs ITSELF, not the people who hold clinics inside it" — and a venue is precisely a
 * building that signs itself. So the venue's typed name is judged against the place names on its own
 * sign, and a sign that names no place at all is a match rather than a hold.
 */
async function venueSignboard(input: {
  name: string;
  photoPath: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
}): Promise<PhoenixCrmSignboardCheck> {
  return readPlaceSignboard({
    customerName: input.name,
    isTest: input.isTest,
    // Never "PM": that mode looks for a PERSON on the sign, which no venue carries.
    listType: "AM",
    photoPath: input.photoPath,
    repHrId: input.repHrId,
    seatId: input.seatId,
  });
}

export type CreatedSharedPlace = { sharedPlaceId: string; capturedAt: string; held: boolean };

/**
 * Capture a venue at its door: the live sign photo, both readings inside the place line, and the name
 * on the building. Fixed for good once saved, exactly as a place is.
 */
export async function createSharedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<CreatedSharedPlace> {
  const body = record(raw);
  const { seat, isTest } = territoryForValidation(viewer, body.seatId, readTestFlag(body.test));
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so its list cannot be changed.");
  const draft = parseSharedPlaceDraft(body.sharedPlace);
  if (!draft.ok) {
    // The reading survives the refusal (owner, 2026-10-03), filed exactly as a place's is. Silent,
    // void and never throwing: the rep reads exactly the refusal below, whether or not this lands.
    await recordRefusedReading({
      subjectKind: "place",
      raw: body.sharedPlace,
      seatId: seat.seatId,
      repHrId: viewer.hrId,
      // A venue belongs to no customer, which is legitimate and must not cost the row — the reading
      // is about the phone, not about the customer.
      customerId: null,
      isTest,
    });
    throw validationError(draft.error);
  }

  const point = placePoint(draft.value);
  const [issuedAt, located, signboard] = await Promise.all([
    photoSlotIssuedAt(draft.value.photoPath),
    // The one resolver a validation and a move already share, so `brick_lookup` keeps its pessimistic
    // default and a venue can never disagree with a place about which brick a point is in.
    resolvePlaceLocation(point),
    venueSignboard({
      isTest,
      name: draft.value.name,
      photoPath: draft.value.photoPath,
      repHrId: viewer.hrId,
      seatId: seat.seatId,
    }),
  ]);

  const result = await callPhoenixCrm<Row>("phoenix_crm_create_shared_place", {
    p: {
      seat_id: seat.seatId,
      line_code: seat.lineCode,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      name: draft.value.name.slice(0, SHARED_PLACE_NAME_MAX),
      kind: draft.value.kind,
      signboard_check: signboard,
      // 🔴 `unjudged` NEVER holds, in any of its reasons (signboardHoldsForReview): the key has run out
      // of credits twice in this system's life, and a hold on the absence of an answer would have
      // stopped every capture in the field on both days.
      ...(signboardHoldsForReview(signboard) ? { hold_review: signboardHoldRecord(signboard, point) } : {}),
      place: {
        photo_path: draft.value.photoPath,
        lat: point.lat,
        lon: point.lon,
        accuracy_meters: point.accuracyMeters,
        point_source: point.source,
        pin_lat: draft.value.lat,
        pin_lon: draft.value.lon,
        pin_accuracy_meters: draft.value.accuracyMeters,
        photo_lat: draft.value.photoLat,
        photo_lon: draft.value.photoLon,
        photo_accuracy_meters: draft.value.photoAccuracyMeters,
        photo_captured_at: draft.value.photoCapturedAt,
        device_skew_minutes: issuedAt ? deviceClockSkewMinutes(draft.value.deviceCapturedAt, new Date(issuedAt)) : null,
        ...located,
      },
    },
  });

  return {
    sharedPlaceId: String(result.shared_place_id),
    capturedAt: String(result.captured_at),
    held: result.held === true,
  };
}

// ── Seating a customer in one ───────────────────────────────────────────────────────────────────

/** The venue a seating is being saved against, with everything the seated row copies from it. */
export type SeatingVenue = {
  sharedPlaceId: string;
  name: string;
  kind: SharedPlaceKind;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  location: Row;
};

/**
 * The venue, checked against this territory before anything is written.
 *
 * Refused in three states, each with its own sentence: gone, removed, or still being checked. The
 * database repeats all three under its own lock, so a phone cannot get round them.
 */
export async function sharedPlaceForSeating(input: {
  seatId: string;
  isTest: boolean;
  sharedPlaceId: string;
}): Promise<SeatingVenue> {
  if (!isUuid(input.sharedPlaceId)) throw validationError("Choose the polyclinic or centre this customer receives in.");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_shared_places")
    .select(SHARED_PLACE_COLUMNS)
    .eq("id", input.sharedPlaceId)
    .eq("seat_id", input.seatId)
    .eq("is_test", input.isTest)
    .maybeSingle();
  throwIfError(error);
  const row = (data ?? null) as Row | null;
  if (!row) throw notFoundError("This polyclinic or centre is no longer there. Reload the page.");
  if (row.status === "retired") throw validationError("This polyclinic or centre was removed. Reload the page.");
  if (row.status === "held") {
    throw validationError(
      "The system is still checking this polyclinic or centre. It confirms it automatically, and then customers can be added in it.",
    );
  }
  return {
    sharedPlaceId: String(row.id),
    name: String(row.name),
    kind: kindOf(row.kind),
    lat: numberOrNull(row.lat) ?? 0,
    lon: numberOrNull(row.lon) ?? 0,
    accuracyMeters: numberOrNull(row.accuracy_meters),
    // 🔴 COPIED, NEVER RE-RESOLVED. It is the SAME point, so re-resolving would pay for a second brick
    // and map lookup to answer a question already answered at the door — and could answer it
    // differently if the brick master changed in between, leaving two rows at one coordinate in two
    // bricks. The venue's own resolution is the record.
    location: {
      address: text(row.address),
      zone: text(row.zone),
      brick_id: text(row.brick_id),
      brick_name: text(row.brick_name),
      brick_distance_km: numberOrNull(row.brick_distance_km),
      brick_lookup: row.brick_lookup === "matched" || row.brick_lookup === "none_nearby" ? row.brick_lookup : "could_not_look",
      area_code: text(row.area_code),
      area_name: text(row.area_name),
      region_code: text(row.region_code),
      region_name: text(row.region_name),
    },
  };
}

/**
 * The seated place as `phoenix_crm_insert_place` reads it.
 *
 * 🔴 NO READING OF ITS OWN, and the nulls are the point: `pin_*` and `photo_*` are left empty because
 * nobody took a reading at this row — the point is the venue's, taken once at its door. Filling them
 * from the venue would be a record claiming a capture that never happened, and `assessCaptureTrust`
 * reads an absence as UNMEASURED, which is exactly what it is.
 */
export async function seatedPlacePayload(venue: SeatingVenue, seated: SeatedPlaceDraft): Promise<Row> {
  const issuedAt = await photoSlotIssuedAt(seated.photoPath).catch(() => null);
  return {
    photo_path: seated.photoPath,
    lat: venue.lat,
    lon: venue.lon,
    accuracy_meters: venue.accuracyMeters,
    point_source: "shared_place",
    shared_place_id: venue.sharedPlaceId,
    // The phone sends no clock on a seating (there is no Capture-location step), so the skew is only
    // the photo's own, read exactly as it is for a place.
    device_skew_minutes: issuedAt ? deviceClockSkewMinutes(null, new Date(issuedAt)) : null,
    label: seated.label,
    ...venue.location,
    timings: seated.timings,
  };
}

/** The draft, parsed, or null when this body is not a seating at all. */
export function seatedDraftOf(body: Row): SeatedPlaceDraft | null {
  if (body.seated === undefined || body.seated === null) return null;
  const parsed = parseSeatedPlaceDraft(body.seated);
  if (!parsed.ok) throw validationError(parsed.error);
  return parsed.value;
}

// ── The administrator's board, and his decision ─────────────────────────────────────────────────

/**
 * A reading, in the shape the review rows already use. It is declared here rather than imported from
 * `server/validation-reviews.ts` deliberately: that file imports `loadSharedPlaceNames` from this
 * one, so an import back would close a cycle.
 */
export type SharedPlaceReading = { lat: number; lon: number; accuracyMeters: number | null };

export type SharedPlaceBoardRow = SharedPlaceRow & {
  repName: string;
  territory: string;
  line: string | null;
  region: string | null;
  isTest: boolean;
  mapsLink: string;
  /** Where the phone stood for the signboard photo, and the standalone Capture-location reading. */
  photo: SharedPlaceReading | null;
  pin: SharedPlaceReading | null;
  signboard: { verdict: string; reason: string | null; signText: string | null; note: string | null } | null;
  decidedAtText: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
};

function readingOf(lat: unknown, lon: unknown, accuracy: unknown): SharedPlaceReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

function signboardOf(value: unknown): SharedPlaceBoardRow["signboard"] {
  const check = value && typeof value === "object" ? (value as Row) : null;
  if (!check || typeof check.verdict !== "string") return null;
  return {
    verdict: check.verdict,
    reason: text(check.reason),
    signText: text(check.signText ?? check.sign_text),
    note: text(check.note),
  };
}

/**
 * Every venue in the company, newest first, for the Polyclinics section of the place-checks page.
 *
 * Paged with a `capped` flag like every board read in this module: a read that silently stopped at
 * 1,000 rows would under-report what is waiting, which `docs/needs-you.md` forbids.
 */
export async function loadSharedPlaceBoard(viewer: PhoenixCrmViewer): Promise<{ rows: SharedPlaceBoardRow[]; capped: boolean }> {
  if (!canDecideSharedPlaces(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_shared_places")
        .select(
          `${SHARED_PLACE_COLUMNS}, created_at, signboard_check, decided_at, decided_by_hr_id, decision_note, ` +
            "pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters",
        )
        // A REJECTED venue is retired and deliberately absent: the rep was told what is wrong with the
        // photo and captures it again, exactly as a refused place behaves. What the administrator said
        // stays on the row for the record, and the customers it sent back show in "Waiting to be
        // captured again" — so there is nothing for this section to draw about it.
        .in("status", ["active", "held"])
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    { maxRows: 10_000, whenFull: "stop", what: "The polyclinics and centres in use", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const rows = read.rows;
  if (rows.length === 0) return { rows: [], capped: false };

  const [counts, names] = await Promise.all([
    seatedCounts(rows.map((row) => String(row.id))),
    loadPeopleNames([...rows.map((row) => text(row.created_by_hr_id)), ...rows.map((row) => text(row.decided_by_hr_id))]),
  ]);

  return {
    capped: read.capped,
    rows: rows.map((row): SharedPlaceBoardRow => {
      const base = mapSharedPlace(row, counts.get(String(row.id)) ?? 0);
      const seat = viewer.org.seats.get(String(row.seat_id));
      return {
        ...base,
        repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
        territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
        line: seat?.lineName ?? null,
        region: seat?.regionName ?? null,
        isTest: row.is_test === true,
        mapsLink: `https://www.google.com/maps/search/?api=1&query=${base.point.lat},${base.point.lon}`,
        photo: readingOf(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
        pin: readingOf(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
        signboard: signboardOf(row.signboard_check),
        decidedAtText: text(row.decided_at) ? formatPhoenixDateTime(String(row.decided_at)) : null,
        decidedByName: text(row.decided_by_hr_id) ? nameOf(names, text(row.decided_by_hr_id), "The administrator") : null,
        decisionNote: text(row.decision_note),
      };
    }),
  };
}

export type SharedPlaceDecision = {
  sharedPlaceId: string;
  name: string;
  status: "active" | "retired";
  placesRetired: number;
  reopened: Array<{ customerId: string; customerName: string; repHrId: string | null }>;
};

/**
 * Approve a venue, or reject it.
 *
 * A rejection retires the venue, retires every place seated in it, and sends each of those customers
 * back to To validate with `reopened_at` stamped — so each one is first in his rep's own list again.
 * The notice they get is the EXISTING `phoenix_crm.validation_not_confirmed`, already on the email
 * allow-list and already worded as the system's rather than a person's (golden rule #1).
 */
export async function decideSharedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<SharedPlaceDecision> {
  if (!canDecideSharedPlaces(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = record(raw);
  if (!isUuid(body.sharedPlaceId)) throw validationError("Choose the polyclinic or centre to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  // A refusal always says what is wrong with the photo, in the owner's own closed list (2026-10-08):
  // the rep is told that reason and nothing else, so a rejection without one is refused here.
  const refusalReason = decision === "reject" ? parseValidationRefusalReason(body.refusalReason) : null;
  if (decision === "reject" && !refusalReason) throw validationError(VALIDATION_REASON_REQUIRED);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_shared_place", {
    p: {
      shared_place_id: String(body.sharedPlaceId).toLowerCase(),
      actor_hr_id: viewer.hrId,
      decision,
      note: typeof body.note === "string" ? body.note : null,
      refusal_reason: refusalReason,
    },
  });

  const reopened = Array.isArray(result.reopened) ? (result.reopened as Row[]) : [];
  // 🔴 THE REJECTION MUST SPEAK. Until 2026-10-09 this returned here, so a refused venue reopened
  // every customer seated in it in SILENCE — against this module's own promise that a rep is told
  // what is wrong with his photo and nothing else, and against the paragraph above this function.
  // One notice per customer actually back under To validate, which is what the RPC returns.
  await tellSeatedRepsValidateAgain(viewer, result, reopened);
  return {
    sharedPlaceId: String(result.shared_place_id),
    name: String(result.name),
    status: result.status === "retired" ? "retired" : "active",
    placesRetired: numberOrNull(result.places_retired) ?? 0,
    reopened: reopened.map((row) => ({
      customerId: String(row.customer_id),
      customerName: String(row.customer_name ?? "This customer"),
      repHrId: text(row.rep_hr_id),
    })),
  };
}

/**
 * Tell every rep whose customer a refused venue just sent back to To validate, and what is wrong with
 * the venue's photo — the EXISTING `phoenix_crm.validation_not_confirmed` notice, with `via`
 * `shared_place` so it carries the venue's wording rather than the six sentences about a customer's
 * own door (`sharedPlaceRefusalRepText`).
 *
 * 🔴 ONLY FOR A CUSTOMER REALLY BACK UNDER TO VALIDATE, and the RPC has already decided that: it puts
 * a row in `reopened` only where the customer ended `pending`, so a seated place whose customer keeps
 * another active place of his own is absent, and no bell is raised about something he cannot act on.
 *
 * The venue's own id stands in for the review id — a venue carries its decision on its own row and has
 * no review row — and a rejected venue is retired for good, so that is one key per refusal, for ever.
 * Never throws: the decision is already committed, and a notice that cannot be raised must not undo it.
 */
async function tellSeatedRepsValidateAgain(viewer: PhoenixCrmViewer, result: Row, reopened: Row[]): Promise<void> {
  if (reopened.length === 0) return;
  const sharedPlaceId = text(result.shared_place_id);
  const seat = viewer.org.seats.get(String(result.seat_id));
  const reason = text(result.refusal_reason);
  if (!sharedPlaceId || !seat) return;
  for (const row of reopened) {
    try {
      const customerId = text(row.customer_id);
      const repHrId = text(row.rep_hr_id);
      if (!customerId || !repHrId) continue;
      await notifyPhoenixCrm(
        {
          kind: "validation_not_confirmed",
          seat,
          repHrId,
          customerId,
          customerName: text(row.customer_name) ?? "A customer",
          reviewId: sharedPlaceId,
          reason,
          via: "shared_place",
        },
        row.is_test === true || result.is_test === true,
      );
    } catch (error) {
      logError("Phoenix CRM shared-place validate-again notice failed", {
        error,
        labels: { event: "phoenix_crm_shared_place_validate_again_notify_failed" },
      });
    }
  }
}

/** Why one customer is waiting to be captured again, when a VENUE's refusal is what reopened him. */
export type SharedPlaceRefusalForCustomer = {
  /** The rep who photographed the TIMETABLE — his capture is the one that was retired. */
  repHrId: string | null;
  sharedPlaceName: string;
  /** A key from `VALIDATION_REFUSAL_REASON_KEYS`, as chosen on the venue. */
  refusalReason: string | null;
};

/**
 * For each of these customers, the refused VENUE behind his reopen — `customerId → the refusal`.
 *
 * 🔴 THE BOARD CANNOT GET THIS FROM A REVIEW ROW, AND READ 'A rep' / 'No reason was chosen' BECAUSE IT
 * TRIED (measured on staging, 2026-10-09, both reopened customers of one rejected venue). A venue
 * refusal writes NO `phoenix_crm_validation_reviews` row for the customer: the reason is stamped on
 * `phoenix_crm_shared_places.refusal_reason`, and the rep is the one on the retired seated place. So
 * the join is place → venue, and a customer whose own place was refused is simply absent from the map.
 */
export async function loadSharedPlaceRefusalsForCustomers(
  customerIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, SharedPlaceRefusalForCustomer>> {
  const byCustomer = new Map<string, SharedPlaceRefusalForCustomer>();
  const places = await selectByIds<Row>(
    "phoenix_crm_places",
    "id, customer_id, shared_place_id, created_by_hr_id, retired_at",
    "customer_id",
    customerIds,
    (query) => query.eq("status", "retired").not("shared_place_id", "is", null),
  );
  if (places.length === 0) return byCustomer;
  // The LATEST retired seating is the one he is waiting on, exactly as the latest refusal is.
  const latest = new Map<string, Row>();
  for (const place of places) {
    const customerId = text(place.customer_id);
    if (!customerId) continue;
    const current = latest.get(customerId);
    if (!current || String(place.retired_at ?? "") > String(current.retired_at ?? "")) latest.set(customerId, place);
  }
  const venues = await selectByIds<Row>(
    "phoenix_crm_shared_places",
    "id, name, status, refusal_reason",
    "id",
    [...latest.values()].map((place) => text(place.shared_place_id)),
  );
  const byVenue = new Map(venues.map((venue) => [String(venue.id), venue] as const));
  for (const [customerId, place] of latest) {
    const venue = byVenue.get(String(place.shared_place_id));
    // A venue still active did not reopen anybody — its places are retired one by one, by a move or a
    // refusal of that seating, and those carry a review row of their own.
    if (!venue || venue.status !== "retired") continue;
    byCustomer.set(customerId, {
      repHrId: text(place.created_by_hr_id),
      sharedPlaceName: String(venue.name ?? "A polyclinic or centre"),
      refusalReason: text(venue.refusal_reason),
    });
  }
  return byCustomer;
}
