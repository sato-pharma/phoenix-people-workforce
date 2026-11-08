import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { parseDoctorFullName, type HeldFullName, type HeldFullNameBoard } from "@/lib/phoenix-crm/pm-name-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { canDecideValidationReviews, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { scheduleOf, signboardOf } from "@/lib/phoenix-crm/server/validation-reviews";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const HELD_LIMIT = 200;

export async function loadHeldFullNames(viewer: PhoenixCrmViewer): Promise<HeldFullName[]> {
  if (!canDecideValidationReviews(viewer)) return [];
  const read = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name, is_test, full_name_held, full_name_held_at, full_name_held_by_hr_id, full_name_held_score, full_name_held_board")
    .not("full_name_held", "is", null)
    .order("full_name_held_at", { ascending: true })
    .limit(HELD_LIMIT);
  throwIfError(read.error);
  const rows = (read.data ?? []) as Row[];
  // Each held customer's places in use, for the row that opens on its signboard (owner, 2026-11-08). At most
  // HELD_LIMIT ids, sent in `selectByIds`'s chunks, never one long `.in()`.
  const places = await selectByIds<Row>(
    "phoenix_crm_places",
    "id, customer_id, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at, signboard_check, shared_place_id, schedule_check",
    "customer_id",
    rows.map((row) => String(row.id)),
    (query) => query.eq("status", "active"),
  );
  const venues = await selectByIds<Row>(
    "phoenix_crm_shared_places",
    "id, name, schedule_photo_path",
    "id",
    places.map((place) => (place.shared_place_id ? String(place.shared_place_id) : null)),
  );
  const venueById = new Map(venues.map((venue) => [String(venue.id), venue]));
  const names = await loadPeopleNames([
    ...rows.map((row) => String(row.full_name_held_by_hr_id ?? "")),
    ...places.map((place) => String(place.created_by_hr_id ?? "")),
  ]);
  const boardsByCustomer = new Map<string, HeldFullNameBoard[]>();
  for (const place of [...places].sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))) {
    const venue = place.shared_place_id ? venueById.get(String(place.shared_place_id)) : undefined;
    const lat = numberOrNull(place.lat);
    const lon = numberOrNull(place.lon);
    const board: HeldFullNameBoard = {
      placeId: String(place.id),
      seated: Boolean(place.shared_place_id),
      photoPath: textOrNull(place.photo_path),
      schedulePhotoPath: venue ? textOrNull(venue.schedule_photo_path) : null,
      venueName: venue ? textOrNull(venue.name) : null,
      placeLabel: textOrNull(place.label),
      address: textOrNull(place.address),
      brickName: textOrNull(place.brick_name),
      areaName: textOrNull(place.area_name),
      validatedAt: String(place.created_at ?? ""),
      validatedBy: nameOf(names, String(place.created_by_hr_id ?? ""), "A rep"),
      photo: readingOf(place.photo_lat, place.photo_lon, place.photo_accuracy_meters),
      pin: readingOf(place.pin_lat, place.pin_lon, place.pin_accuracy_meters),
      mapsLink: lat === null || lon === null ? null : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
      signboard: signboardOf(place.signboard_check),
      schedule: scheduleOf(place.schedule_check),
    };
    const key = String(place.customer_id);
    boardsByCustomer.set(key, [...(boardsByCustomer.get(key) ?? []), board]);
  }
  return rows.map((row) => ({
    customerId: String(row.id),
    currentName: String(row.name ?? ""),
    fullName: String(row.full_name_held ?? ""),
    percent: numberOrNull(row.full_name_held_score),
    boardNames: Array.isArray(row.full_name_held_board) ? row.full_name_held_board.map(String) : [],
    repName: nameOf(names, String(row.full_name_held_by_hr_id ?? ""), "A rep"),
    heldAt: String(row.full_name_held_at ?? ""),
    isTest: row.is_test === true,
    boards: boardsByCustomer.get(String(row.id)) ?? [],
  }));
}

function textOrNull(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

function readingOf(lat: unknown, lon: unknown, accuracy: unknown): HeldFullNameBoard["photo"] {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

/**
 * 🔴 THE SUPER ADMIN AND THE SFE MANAGER CORRECT A HELD NAME — WHOEVER DECIDES IT (owner, 2026-11-08, widening his own "the admin only, not the SFE" of the same evening: "make the edit names appear to sfe manager").
 * It was the Super Admin's alone for its first hour. Now it is exactly `canDecideValidationReviews`: the Super
 * Admin on `update`, the SFE Manager on `approve` — never `update` handed to him, never a test account, never
 * a district manager. The route asks `approve` (one permission per route, the module's rule) and this is the gate
 * for a correction, checked before the database is called.
 */
export function canCorrectHeldFullName(viewer: PhoenixCrmViewer): boolean {
  return canDecideValidationReviews(viewer);
}

/** Whether a request carries a corrected name, which only `canCorrectHeldFullName` may send. */
export function correctsHeldFullName(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && (raw as Row).nameParts !== undefined && (raw as Row).nameParts !== null);
}

export async function decideHeldFullName(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; decision: "approve" | "reject"; corrected: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const customerId = String(body.customerId).toLowerCase();

  // A corrected name: the deciders' (the Super Admin and the SFE Manager), on approve only, and held to the same three-name rules a rep's
  // own boxes are (no title, no place word, one name a box). The board match is not asked again — he is the
  // one deciding that the board was misread.
  let name: string | null = null;
  if (correctsHeldFullName(body)) {
    if (!canCorrectHeldFullName(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager correct a name.");
    if (decision !== "approve") throw validationError("A corrected name is saved with Approve.");
    const parsed = parseDoctorFullName(body.nameParts, null);
    if (!parsed.ok) throw validationError(parsed.error);
    name = parsed.value;
  }

  await callPhoenixCrm<Row>("phoenix_crm_decide_full_name", {
    p: name === null ? { customer_id: customerId, actor_hr_id: viewer.hrId, decision } : { customer_id: customerId, actor_hr_id: viewer.hrId, decision, name },
  });
  return { customerId, decision, corrected: name !== null };
}
