/**
 * Phoenix CRM — the same place validated by more than one rep: the read and the Super Admin's answers
 * (owner, 2026-10-17, the third tab of Place checks).
 *
 * The rule is `place-match-groups.ts`; this file is only what feeds it and what stores what he says.
 *
 * 🔴 THE SUPER ADMIN'S ALONE — the same decider as every Place check (`canDecideValidationReviews`). The
 * comparison sets one rep's readings beside another's, across teams, so a district manager's own board
 * never carries it: it would show him a colleague's work.
 *
 * 🔴 EVERY READ IS PAGED. ~2,000 places are validated and the field is growing; a bare read answers its
 * first 1,000 rows and says nothing, which here would silently drop the half of a group that sorted
 * later.
 *
 * 🔴 A SEATED CUSTOMER IS NEVER A SUBJECT. He sits on his building's own point, so listing him would put
 * every doctor in a polyclinic "beside" the polyclinic they are in and call it agreement. The building is
 * the validation; its seated count is shown on it.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { distanceMeters, isUsableFix } from "@/lib/phoenix-crm/geo";
import {
  buildPlaceMatchBoard,
  MAX_ANSWER_PAIRS,
  orderedPair,
  type MatchAnswerRow,
  type MatchPointSource,
  type MatchSignboard,
  type MatchSubject,
  type PlaceMatchBoard,
} from "@/lib/phoenix-crm/place-match-groups";
import { parseSharedPlaceKind, sharedPlaceKindLabel } from "@/lib/phoenix-crm/shared-place-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { canDecideValidationReviews, placeChecksSeatScope, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { numberOrNull, seatScoped, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}


/** The Super Admin, and nobody else. Named here so the page, the route and the test say one thing. */
export function canReadPlaceMatches(viewer: PhoenixCrmViewer): boolean {
  return canDecideValidationReviews(viewer);
}

/** A stored signboard verdict, read defensively: anything unrecognised is "not read". */
export function matchSignboardOf(value: unknown): MatchSignboard {
  if (!value || typeof value !== "object") return null;
  const verdict = (value as Row).verdict;
  return verdict === "match" || verdict === "other_name" || verdict === "no_name" || verdict === "unjudged" ? verdict : null;
}

function pointSourceOf(value: unknown): MatchPointSource {
  return value === "photo" || value === "pin" || value === "shared_place" ? value : null;
}

/**
 * The anchor of one validation: its PHOTOGRAPH's fix when it has a usable one (the shutter took it at the
 * door — the Place checks' own anchor rule), otherwise the stored point. The pin gap is how far the rep's
 * pin sits from his own photograph, and is null unless he has both.
 */
export function matchAnchorOf(row: Row): {
  point: { lat: number; lon: number };
  accuracyMeters: number | null;
  pinGapMeters: number | null;
} | null {
  const photo = isUsableFix(row.photo_lat, row.photo_lon) ? { lat: Number(row.photo_lat), lon: Number(row.photo_lon) } : null;
  const pin = isUsableFix(row.pin_lat, row.pin_lon) ? { lat: Number(row.pin_lat), lon: Number(row.pin_lon) } : null;
  const stored = isUsableFix(row.lat, row.lon) ? { lat: Number(row.lat), lon: Number(row.lon) } : null;
  const point = photo ?? stored ?? pin;
  if (!point) return null;
  const accuracy = photo ? numberOrNull(row.photo_accuracy_meters) : stored ? numberOrNull(row.accuracy_meters) : numberOrNull(row.pin_accuracy_meters);
  return {
    point,
    accuracyMeters: accuracy,
    pinGapMeters: photo && pin ? distanceMeters(photo, pin) : null,
  };
}

const PLACE_COLUMNS =
  "id, seat_id, customer_id, label, address, brick_name, area_name, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, " +
  "photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at, signboard_check, shared_place_id, point_source";

const VENUE_COLUMNS =
  "id, seat_id, name, kind, status, address, brick_name, area_name, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, " +
  "photo_lat, photo_lon, photo_accuracy_meters, photo_path, captured_at, created_by_hr_id, signboard_check, point_source";

export type PlaceMatchRead = { board: PlaceMatchBoard; capped: boolean };

export async function loadPlaceMatchBoard(viewer: PhoenixCrmViewer): Promise<PlaceMatchRead> {
  if (!canReadPlaceMatches(viewer)) throw forbiddenError("Only the Super Admin reads this.");
  const seats = placeChecksSeatScope(viewer);

  const [placeRead, venueRead, answerRead] = await Promise.all([
    readEveryPage<Row>(
      () =>
        seatScoped(getSupabaseAdmin().from("phoenix_crm_places").select(PLACE_COLUMNS).eq("status", "active").eq("is_test", false), seats)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
      { maxRows: 10_000, whenFull: "stop", what: "The validated places in use", uniqueBy: (row) => String(row.id) },
    ),
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_shared_places")
          .select(VENUE_COLUMNS)
          .in("status", ["active", "held"])
          .eq("is_test", false)
          .order("captured_at", { ascending: false })
          .order("id", { ascending: false }),
      { maxRows: 5_000, whenFull: "stop", what: "The polyclinics and centres in use", uniqueBy: (row) => String(row.id) },
    ),
    readEveryPage<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_place_match_answers").select("subject_a, subject_b, answer").order("subject_a").order("subject_b"),
      { maxRows: 50_000, whenFull: "stop", what: "The same-place answers", uniqueBy: (row) => `${String(row.subject_a)}|${String(row.subject_b)}` },
    ),
  ]);
  throwIfError(placeRead.error);
  throwIfError(venueRead.error);
  throwIfError(answerRead.error);

  const allPlaces = placeRead.rows;
  const places = allPlaces.filter((row) => !text(row.shared_place_id));
  const venues = venueRead.rows;
  // How many are seated in each building, off the same read — never a second one.
  const seatedByVenue = new Map<string, number>();
  for (const row of allPlaces) {
    const venueId = text(row.shared_place_id);
    if (venueId) seatedByVenue.set(venueId, (seatedByVenue.get(venueId) ?? 0) + 1);
  }

  const customerIds = [...new Set(places.map((row) => String(row.customer_id)))];
  const [customers, reviews, names] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type, speciality", "id", customerIds),
    selectByIds<Row>("phoenix_crm_validation_reviews", "id, place_id, status", "customer_id", customerIds),
    loadPeopleNames([...places.map((row) => text(row.created_by_hr_id)), ...venues.map((row) => text(row.created_by_hr_id))]),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const waitingPlaces = new Set(reviews.filter((row) => row.status === "pending").map((row) => String(row.place_id)));

  const subjects: MatchSubject[] = [];
  for (const row of places) {
    const anchor = matchAnchorOf(row);
    if (!anchor) continue;
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const seat = viewer.org.seats.get(String(row.seat_id));
    const customerName = String(customer.name ?? "Unknown customer");
    subjects.push({
      key: `place:${String(row.id)}`,
      kind: "place",
      id: String(row.id),
      seatId: String(row.seat_id),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      title: customerName,
      subtitle: [text(customer.list_type), text(customer.speciality)].filter(Boolean).join(" · ") || null,
      listType: String(customer.list_type ?? ""),
      speciality: text(customer.speciality),
      nameKey: normalizeContactName(customerName),
      point: anchor.point,
      accuracyMeters: anchor.accuracyMeters,
      pinGapMeters: anchor.pinGapMeters,
      pointSource: pointSourceOf(row.point_source),
      signboard: matchSignboardOf(row.signboard_check),
      brickName: text(row.brick_name),
      areaName: text(row.area_name),
      address: text(row.address),
      capturedAt: String(row.created_at),
      capturedAtText: formatPhoenixDateTime(String(row.created_at)),
      photoPath: text(row.photo_path),
      seated: 0,
      waiting: waitingPlaces.has(String(row.id)),
    });
  }
  for (const row of venues) {
    const anchor = matchAnchorOf(row);
    if (!anchor) continue;
    const seat = viewer.org.seats.get(String(row.seat_id));
    subjects.push({
      key: `venue:${String(row.id)}`,
      kind: "venue",
      id: String(row.id),
      seatId: String(row.seat_id),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      title: String(row.name),
      subtitle: sharedPlaceKindLabel(parseSharedPlaceKind(row.kind) ?? "polyclinic") ?? "Polyclinic",
      listType: "",
      speciality: null,
      nameKey: "",
      point: anchor.point,
      accuracyMeters: anchor.accuracyMeters,
      pinGapMeters: anchor.pinGapMeters,
      pointSource: pointSourceOf(row.point_source),
      signboard: matchSignboardOf(row.signboard_check),
      brickName: text(row.brick_name),
      areaName: text(row.area_name),
      address: text(row.address),
      capturedAt: String(row.captured_at),
      capturedAtText: formatPhoenixDateTime(String(row.captured_at)),
      photoPath: text(row.photo_path),
      seated: seatedByVenue.get(String(row.id)) ?? 0,
      waiting: row.status === "held",
    });
  }

  const answers: MatchAnswerRow[] = answerRead.rows.map((row) => ({
    a: String(row.subject_a),
    b: String(row.subject_b),
    answer: row.answer === "same" ? "same" : "different",
  }));
  return {
    board: buildPlaceMatchBoard({ subjects, answers }),
    capped: placeRead.capped || venueRead.capped,
  };
}

// ── What he says ────────────────────────────────────────────────────────────────────────────────

/** `place:<uuid>` or `venue:<uuid>` — nothing else is ever stored under an answer. */
const SUBJECT_KEY = /^(place|venue):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PlaceMatchAnswerResult = { answer: "same" | "different" | "forget"; pairs: number };

/**
 * Save an answer for the pairs of one question, or take it back (`forget`).
 *
 * The pairs are keys the board itself drew, so this validates their SHAPE and stores them — it does not
 * recompute the question: whether two readings are one place is his call, and a stored answer about a
 * subject that no longer exists is inert.
 */
export async function answerPlaceMatch(viewer: PhoenixCrmViewer, raw: unknown): Promise<PlaceMatchAnswerResult> {
  if (!canReadPlaceMatches(viewer)) throw forbiddenError("Only the Super Admin answers this.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const answer = body.answer === "same" ? "same" : body.answer === "different" ? "different" : body.answer === "forget" ? "forget" : null;
  if (!answer) throw validationError("Choose same place, different places, or take the answer back.");
  const rawPairs = Array.isArray(body.pairs) ? (body.pairs as unknown[]) : [];
  if (rawPairs.length === 0 || rawPairs.length > MAX_ANSWER_PAIRS) throw validationError("That answer does not name a pair of validations.");

  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const entry of rawPairs) {
    if (!Array.isArray(entry) || entry.length !== 2) throw validationError("That answer does not name a pair of validations.");
    const first = String(entry[0] ?? "");
    const second = String(entry[1] ?? "");
    if (!SUBJECT_KEY.test(first) || !SUBJECT_KEY.test(second) || first === second) throw validationError("That answer does not name a pair of validations.");
    const [low, high] = orderedPair(first, second);
    const id = `${low}|${high}`;
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push([low, high]);
  }

  const admin = getSupabaseAdmin();
  if (answer === "forget") {
    for (const [low, high] of pairs) {
      const { error } = await admin.from("phoenix_crm_place_match_answers").delete().eq("subject_a", low).eq("subject_b", high);
      throwIfError(error);
    }
    return { answer, pairs: pairs.length };
  }
  const decidedAt = new Date().toISOString();
  const { error } = await admin.from("phoenix_crm_place_match_answers").upsert(
    pairs.map(([low, high]) => ({ subject_a: low, subject_b: high, answer, decided_by_hr_id: viewer.hrId, decided_at: decidedAt })),
    { onConflict: "subject_a,subject_b" },
  );
  throwIfError(error);
  return { answer, pairs: pairs.length };
}
