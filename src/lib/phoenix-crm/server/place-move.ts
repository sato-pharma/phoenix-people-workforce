/**
 * Phoenix CRM — moving a validated place: the Super Admin and the SFE Manager, nobody else.
 *
 * Owner, 2026-09-29: "the location is fixed forever, only the system administrator changes it" — widened
 * by him the same day to the SFE Manager. A rep never moves a place and is never offered to; the one
 * way a place moves is this, with a written reason, and every move is an audited `place_moved` event
 * holding the point before and after (phoenix_crm_move_place).
 *
 * The new point is chosen, never typed as an address: one of the two readings the rep captured at the
 * door (the Capture-location pin or the photo's own reading — the usual fix when the fixed point came
 * from the wrong one), or coordinates the mover pastes from a map. Either way the address, brick, area
 * and region are resolved HERE from the point, by the same `resolvePlaceLocation` a validation uses, so
 * a moved place and a freshly validated one can never disagree about which brick a point is in.
 *
 * Every visit to the customer is then measured again against the moved place (visit-locations.ts).
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { assertPlaceMover, readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { resolvePlaceLocation, territoryOfSeat } from "@/lib/phoenix-crm/server/place-location";
import { canDecideSharedPlaces, sharedPlaceForSeating } from "@/lib/phoenix-crm/server/shared-places";
import { settleVenueTimetable } from "@/lib/phoenix-crm/server/venue-timetable";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { followLineTwinCopiesQuietly } from "@/lib/phoenix-crm/server/line-twins";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The written reason a move needs — the database refuses anything shorter or longer. */
export const PLACE_MOVE_REASON_MIN = 10;
export const PLACE_MOVE_REASON_MAX = 500;

/** Where the moved place goes: one of its own two readings, or coordinates from a map. */
export type PlaceMoveTarget = "pin" | "photo" | "coordinates";

export type PlaceMoveResult = { placeId: string; customerId: string; movedAt: string };

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

/**
 * "30.0444, 31.2357" or two separate numbers — what a mover pastes from a map. Null when it is not a
 * usable point inside Egypt's field range (the same bounds every capture is held to).
 */
export function parseMoveCoordinates(body: Row): { lat: number; lon: number } | null {
  let lat: unknown = body.lat;
  let lon: unknown = body.lon;
  if (typeof body.coordinates === "string") {
    const parts = body.coordinates.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 2) [lat, lon] = parts;
  }
  if (!isUsableFix(lat, lon)) return null;
  return { lat: Number(lat), lon: Number(lon) };
}

export async function movePlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<PlaceMoveResult> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertPlaceMover(viewer, seat, isTest);
  if (!isUuid(body.placeId)) throw validationError("Choose the place to move.");
  const placeId = String(body.placeId).toLowerCase();
  const reason = cleanText(body.reason, PLACE_MOVE_REASON_MAX);
  if (!reason || reason.length < PLACE_MOVE_REASON_MIN) {
    throw validationError(`Write why the place is moved (at least ${PLACE_MOVE_REASON_MIN} characters).`);
  }

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, customer_id, status, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters")
    .eq("id", placeId)
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .maybeSingle();
  throwIfError(error);
  const place = data as Row | null;
  if (!place) throw notFoundError("This place is no longer on the list. Reload the list.");

  const target: PlaceMoveTarget = body.target === "pin" || body.target === "photo" ? (body.target as PlaceMoveTarget) : "coordinates";
  let point: { lat: number; lon: number; accuracyMeters: number | null };
  if (target === "coordinates") {
    const typed = parseMoveCoordinates(body);
    if (!typed) throw validationError("Paste the place's coordinates from a map, like 30.0444, 31.2357.");
    point = { ...typed, accuracyMeters: null };
  } else {
    const lat = numberOrNull(place[`${target}_lat`]);
    const lon = numberOrNull(place[`${target}_lon`]);
    if (lat === null || lon === null) {
      throw validationError(target === "photo" ? "This place has no photo reading to move to." : "This place has no pin reading to move to.");
    }
    point = { lat, lon, accuracyMeters: numberOrNull(place[`${target}_accuracy_meters`]) };
  }

  // The mover's own seat territory breaks a near tie exactly as a validation's does — a move and a
  // capture must never disagree about which brick a point is in.
  const location = await resolvePlaceLocation(point, territoryOfSeat(seat));
  const result = await callPhoenixCrm<Row>("phoenix_crm_move_place", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      place_id: placeId,
      reason,
      location: { lat: point.lat, lon: point.lon, accuracy_meters: point.accuracyMeters, ...location },
    },
  });
  const moved: PlaceMoveResult = {
    placeId: String(result.place_id),
    customerId: String(result.customer_id),
    movedAt: String(result.moved_at),
  };
  await restampVisitLocationsQuietly({
    seatId: seat.seatId,
    isTest,
    customerId: moved.customerId,
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  // Its copies on the other lines moved with it in the database (owner, 2026-11-12; line-twins.ts).
  await followLineTwinCopiesQuietly([moved.placeId], viewer.config.settings);
  return moved;
}

/**
 * Removing one of a customer's places — a change of where he is, so the movers' alone, exactly as a
 * move is. The database keeps his last place (`last_place`): a customer leaves the list by a drop.
 *
 * 🔴 IT TAKES THE SAME WRITTEN REASON AS A MOVE, AND RE-MEASURES THE SAME WAY. It used to take neither:
 * the audited event was `place_retired` with `'{}'` for details, so the one question anybody would ever
 * ask of it — why is this clinic gone — had no answer on the record; and the visits already stamped
 * against the removed clinic kept their distance and their "ok", measured against a door the movers had
 * just decided was not the customer's. A wrongly added clinic is exactly how a far visit reads as near,
 * which is the whole reason the place-vs-actual report exists. Removing a place changes where the
 * customer is every bit as much as moving one does, so it is kept and re-measured identically.
 */
export async function retirePlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; customerId: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  assertPlaceMover(viewer, seat, isTest);
  if (!isUuid(body.placeId)) throw validationError("Choose the place to remove.");
  const reason = cleanText(body.reason, PLACE_MOVE_REASON_MAX);
  if (!reason || reason.length < PLACE_MOVE_REASON_MIN) {
    throw validationError(`Write why the place is removed (at least ${PLACE_MOVE_REASON_MIN} characters).`);
  }
  const result = await callPhoenixCrm<Row>("phoenix_crm_update_place", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      place_id: String(body.placeId).toLowerCase(),
      action: "retire",
      reason,
    },
  });
  const retired = { placeId: String(result.place_id), customerId: String(result.customer_id) };
  // "all", as a move does: a visit stamped against the clinic that has just gone must be judged again
  // from the places the customer really has, and `placesFor` keeps it to the ones captured before it.
  await restampVisitLocationsQuietly({
    seatId: seat.seatId,
    isTest,
    customerId: retired.customerId,
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  // Its copies on the other lines were removed with it in the database; their doctors are measured
  // again and offered to any twin still validated (owner, 2026-11-12; line-twins.ts).
  await followLineTwinCopiesQuietly([retired.placeId], viewer.config.settings, { retired: true });
  return retired;
}

export type SeatedInVenueResult = {
  sharedPlaceId: string;
  sharedPlaceName: string;
  seated: { placeId: string; customerId: string; customerName: string }[];
  timetableOnFile: boolean;
  /** Customers taken out of the KPIs until the building's timetable names them. */
  held: number;
};

/** One hand-ticked list is never longer than this; the database repeats the ceiling. */
export const SEAT_IN_VENUE_MAX_PLACES = 60;

/**
 * The Super Admin moves standalone customers INTO a validated polyclinic (owner, 2026-10-10).
 *
 * 🔴 SUPER ADMIN ONLY, through `canDecideSharedPlaces` — deliberately NOT `assertPlaceMover`, which also
 * admits the SFE Manager. Each place takes the venue's point exactly (phoenix_crm_seat_places_in_venue);
 * nothing about its location is offered to choose. Where the building has a timetable it is read for
 * each customer, and a confident negative holds him out of the KPIs; `unjudged` NEVER does.
 */
export async function seatPlacesInVenue(viewer: PhoenixCrmViewer, raw: unknown): Promise<SeatedInVenueResult> {
  const body = record(raw);
  const { seat, isTest } = territoryForRead(viewer, body.seatId, readTestFlag(body.test));
  if (!canDecideSharedPlaces(viewer)) throw forbiddenError("Only the Super Admin moves a customer into a polyclinic.");
  const ids = Array.isArray(body.placeIds) ? body.placeIds : [];
  if (ids.length === 0) throw validationError("Tick at least one customer to move into the polyclinic.");
  if (ids.length > SEAT_IN_VENUE_MAX_PLACES) throw validationError("Move at most 60 customers at a time.");
  if (!ids.every((id) => isUuid(id))) throw validationError("Reload the list and tick the customers again.");
  const placeIds = [...new Set(ids.map((id) => String(id).toLowerCase()))];
  const reason = cleanText(body.reason, PLACE_MOVE_REASON_MAX);
  if (!reason || reason.length < PLACE_MOVE_REASON_MIN) {
    throw validationError(`Write why they are moved (at least ${PLACE_MOVE_REASON_MIN} characters).`);
  }
  // The venue read gives the three-state refusal and the copied location block; the database repeats
  // all three under its own lock.
  const venue = await sharedPlaceForSeating({ seatId: seat.seatId, isTest, sharedPlaceId: String(body.sharedPlaceId ?? "") });

  const result = await callPhoenixCrm<Row>("phoenix_crm_seat_places_in_venue", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      shared_place_id: venue.sharedPlaceId,
      place_ids: placeIds,
      reason,
    },
  });
  const seated = (Array.isArray(result.seated) ? result.seated : []).map((entry) => {
    const row = record(entry);
    return { placeId: String(row.place_id), customerId: String(row.customer_id), customerName: String(row.customer_name ?? "") };
  });
  const timetableOnFile = result.timetable_on_file === true;

  // The building's board, read for each of them and settled — silently, after the commit. Where the
  // building has none, the database already held them out of the KPIs. `unjudged` NEVER holds.
  if (timetableOnFile) {
    await settleVenueTimetable({ viewer, seatId: seat.seatId, isTest, sharedPlaceId: venue.sharedPlaceId, schedulePhotoPath: venue.schedulePhotoPath });
  }
  for (const entry of seated) {
    await restampVisitLocationsQuietly({
      seatId: seat.seatId,
      isTest,
      customerId: entry.customerId,
      actorHrId: viewer.hrId,
      settings: viewer.config.settings,
      scope: "all",
    });
  }
  return {
    sharedPlaceId: venue.sharedPlaceId,
    sharedPlaceName: String(result.shared_place_name ?? venue.name),
    seated,
    timetableOnFile,
    held: Array.isArray(result.held) ? result.held.length : 0,
  };
}
