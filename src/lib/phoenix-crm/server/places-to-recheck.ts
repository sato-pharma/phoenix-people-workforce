/**
 * Phoenix CRM — the places worth a second look, read (owner, 2026-11-11). The rules are
 * `@/lib/phoenix-crm/places-to-recheck-rules`; this file reads what they judge and names what they find.
 *
 * Three reads, each narrow: the active places that carry both readings or were refused or visited, the
 * far refusals of the last 30 days, and the visits of the same window that were measured against a place.
 * The Super Admin and the SFE Manager only (`canDecideFarVisitHolds`) — the page asks first, and this asks
 * again. Real work only: a test-world place is never listed.
 */

import { buildCaseMap, type CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import { forbiddenError } from "@/lib/http/api-errors";
import { RECHECK_LOOKBACK_DAYS } from "@/lib/phoenix-crm/far-visit-safeguards";
import {
  placesToRecheck,
  recheckSentence,
  type PlaceToRecheck,
  type RecheckPlace,
  type RecheckRefusal,
  type RecheckVisit,
} from "@/lib/phoenix-crm/places-to-recheck-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { canDecideFarVisitHolds } from "@/lib/phoenix-crm/server/far-visit-safeguards";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const PLACE_COLUMNS =
  "id, customer_id, seat_id, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, point_source, moved_at, trusted_basis, address";

/** The page draws at most this many; the count above the table is always the whole list. */
export const PLACES_TO_RECHECK_SHOWN = 60;

const RECHECK_MAP_SIZE = { width: 256, height: 256, padding: 32 };
const SAVED_PLACE_LABEL = "Customer's saved place";

function placeOf(row: Row): RecheckPlace {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    seatId: String(row.seat_id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    pinLat: numberOrNull(row.pin_lat),
    pinLon: numberOrNull(row.pin_lon),
    pinAccuracyMeters: numberOrNull(row.pin_accuracy_meters),
    photoLat: numberOrNull(row.photo_lat),
    photoLon: numberOrNull(row.photo_lon),
    photoAccuracyMeters: numberOrNull(row.photo_accuracy_meters),
    pointSource: typeof row.point_source === "string" ? row.point_source : null,
    movedAt: typeof row.moved_at === "string" ? row.moved_at : null,
    trusted: row.trusted_basis !== null && row.trusted_basis !== undefined,
  };
}

/** Everything the rules read, for real work. Throws on a failed read: a list that cannot be read is not empty. */
export async function readPlacesToRecheck(now: Date = new Date()): Promise<{ list: PlaceToRecheck[]; places: Map<string, Row> }> {
  const supabase = getSupabaseAdmin();
  const since = new Date(now.getTime() - RECHECK_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const [placeRows, refusalRows, visitRows] = await Promise.all([
    fetchAllRowsKeyset<Row>(() => supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).eq("status", "active").eq("is_test", false).neq("point_source", "line_twin"), {
      cursorColumn: "id",
      cursorOf: (row) => String(row.id),
    }),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_refused_readings")
          .select("id, place_id, lat, lon, accuracy_meters, refused_at")
          .eq("reason", "far_from_place")
          .eq("subject_kind", "visit")
          .eq("is_test", false)
          .not("place_id", "is", null)
          .gte("refused_at", since),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_visits")
          .select("id, place_id, location_flag, captured_at")
          .eq("is_test", false)
          .is("archived_at", null)
          .is("imported_from_ireports360_at", null)
          .not("place_id", "is", null)
          .gte("captured_at", since),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  ]);
  const refusals: RecheckRefusal[] = [];
  for (const row of refusalRows) {
    const lat = numberOrNull(row.lat);
    const lon = numberOrNull(row.lon);
    if (lat === null || lon === null || typeof row.refused_at !== "string") continue;
    refusals.push({ placeId: row.place_id ? String(row.place_id) : null, lat, lon, accuracyMeters: numberOrNull(row.accuracy_meters), refusedAt: row.refused_at });
  }
  const visits: RecheckVisit[] = visitRows.map((row) => ({
    placeId: row.place_id ? String(row.place_id) : null,
    far: row.location_flag === "far",
    capturedAt: typeof row.captured_at === "string" ? row.captured_at : null,
  }));
  return {
    list: placesToRecheck({ places: placeRows.map(placeOf), refusals, visits }),
    places: new Map(placeRows.map((row) => [String(row.id), row])),
  };
}

export type PlaceToRecheckRow = {
  placeId: string;
  seatId: string;
  customerName: string;
  territory: string;
  repName: string | null;
  /** One sentence per reason the place is listed. */
  sentences: string[];
  place: { lat: number; lon: number; address: string | null };
  candidate: { lat: number; lon: number; accuracyMeters: number | null } | null;
  map: CaseMap | null;
};

export async function loadPlacesToRecheck(viewer: PhoenixCrmViewer): Promise<{ total: number; rows: PlaceToRecheckRow[] }> {
  if (!canDecideFarVisitHolds(viewer)) throw forbiddenError("Only the SFE Manager or the Super Admin reads the places to re-check.");
  const { list, places } = await readPlacesToRecheck();
  const shown = list.slice(0, PLACES_TO_RECHECK_SHOWN);
  if (shown.length === 0) return { total: 0, rows: [] };

  const supabase = getSupabaseAdmin();
  const customerName = new Map<string, string>();
  for (const part of chunk([...new Set(shown.map((entry) => entry.customerId))], 200)) {
    const { data, error } = await supabase.from("phoenix_crm_customers").select("id, name").in("id", part);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) customerName.set(String(row.id), String(row.name ?? ""));
  }
  const occupants = shown.map((entry) => viewer.org.seats.get(entry.seatId)?.occupantHrId ?? null).filter((hrId): hrId is string => hrId !== null);
  const people = await loadPeopleNames(occupants);

  const rows = shown.map((entry): PlaceToRecheckRow => {
    const seat = viewer.org.seats.get(entry.seatId);
    const placeRow = places.get(entry.placeId);
    const place = {
      lat: Number(placeRow?.lat),
      lon: Number(placeRow?.lon),
      address: typeof placeRow?.address === "string" ? placeRow.address : null,
    };
    const candidate = entry.candidate ? { ...entry.candidate, accuracyMeters: null } : null;
    return {
      placeId: entry.placeId,
      seatId: entry.seatId,
      customerName: customerName.get(entry.customerId) || "A customer",
      territory: seat ? territoryName(seat) : "A territory no longer on the team",
      repName: seat?.occupantHrId ? nameOf(people, seat.occupantHrId, "") || null : null,
      sentences: entry.findings.map((finding) => recheckSentence(finding, RECHECK_LOOKBACK_DAYS)),
      place,
      candidate,
      map: candidate
        ? buildCaseMap(
            [
              { label: entry.candidateLabel ?? "Where it may belong", lat: candidate.lat, lon: candidate.lon, accuracyMeters: null },
              { label: SAVED_PLACE_LABEL, lat: place.lat, lon: place.lon, accuracyMeters: null },
            ],
            RECHECK_MAP_SIZE,
          )
        : null,
    };
  });
  return { total: list.length, rows };
}
