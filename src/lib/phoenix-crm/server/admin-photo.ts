/**
 * Phoenix CRM — the Super Admin validates a customer for a rep with a PHOTO HE UPLOADS, and the location is the
 * REP'S OWN live reading, taken while the Super Admin's watch is on (owner, 2026-11-20).
 *
 * His words: "the system administrator can validate for someone and upload a photo manually instead of the live",
 * then "make a button for me to press on watch the rep while capturing location. And then while this button is
 * on, the rep will capture the location. You will capture his location and put it here."
 *
 * The four steps, each its own door:
 *   1. ARM (Super Admin): the photo is uploaded through the same slot a rep's photo takes (`uploadPhotoForSlot`,
 *      a slot-shaped path, consumed at once by `phoenix_crm_take_photo`), and a watch row opens on the customer
 *      for `ADMIN_PHOTO_WATCH_MINUTES`. One open watch per customer: a second press closes the first.
 *   2. CAPTURE (the rep, or a manager of the territory — `territoryForValidation`, the gate a rep's own
 *      validation uses): the Capture-location reading is written onto the open watch. Nothing else from the
 *      browser is read; the time is the server's.
 *   3. APPLY (Super Admin): the brick and area are resolved from the rep's reading by `resolvePlaceLocation`,
 *      the seat's own area breaking a tie, and `phoenix_crm_validate_with_admin_photo` writes the place and
 *      validates the customer in one transaction under the seat's lock.
 *   4. CANCEL / WATCH AGAIN (Super Admin).
 *
 * 🔴 A PHOTO SEALED BY THE PHOENIX CAMERA CARRIES ITS OWN READING (owner, 20 Nov 2026: the separate camera app for
 * a clinic with no network). At ARM the seal is judged in full (`checkFieldCameraPhoto`: the picture unchanged,
 * the phone's secure chip, our app, no fake location, satellite time); when it holds, the watch is born
 * `captured` with the seal's satellite fix as the rep's reading and `rep_source = 'sealed_photo'`, its window
 * already closed, so no rep is asked and nothing the rep sends can replace it. When it does not hold, nothing is
 * uploaded and the refusal names why. A file with no seal takes the four steps above, unchanged.
 *
 * 🔴 NO PHOTO, NO VALIDATION; NO REP READING, NO VALIDATION — the database refuses a watch with no reading and a
 * place with no photo. 🔴 THE SUPER ADMIN'S ALONE on his side (`canDecideSharedPlaces`, never a test persona),
 * checked before anything is read. 🔴 Golden rule #1 on the rep's side: he reads "capture the location of this
 * customer" and nothing about a watch, an accuracy or who asked (`AdminPhotoRepAsk` carries no more).
 */

import { ApiError, conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  adminPhotoReadingProblem,
  adminPhotoTimeText,
  adminPhotoWatchIsOpen,
  adminPhotoWatchUntil,
  type AdminPhotoStatus,
} from "@/lib/phoenix-crm/admin-photo-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { seatOccupants } from "@/lib/phoenix-crm/scope";
import { SEAL_MAX_AGE_HOURS } from "@/lib/phoenix-crm/field-camera/seal-rules";
import { readTestFlag, territoryForRead, territoryForValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { shareAcrossLinesQuietly } from "@/lib/phoenix-crm/server/line-twins";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { hasSealTrailer } from "@/lib/phoenix-crm/field-camera/seal-format";
import { checkFieldCameraPhoto, type FieldCameraReport } from "@/lib/phoenix-crm/server/field-camera";
import { decodeJpegDataUrl, uploadPhotoBytesForSlot } from "@/lib/phoenix-crm/server/photos";
import { resolvePlaceLocation } from "@/lib/phoenix-crm/server/place-location";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { canDecideSharedPlaces } from "@/lib/phoenix-crm/server/shared-places";
import { blockedReasonFor, seatAreaCodes } from "@/lib/phoenix-crm/server/trusted-point";
import { withdrawValidationNotConfirmed } from "@/lib/phoenix-crm/server/validation-reviews";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const TABLE = "phoenix_crm_admin_photo_validations";
const WATCH_COLUMNS =
  "id, customer_id, seat_id, is_test, photo_path, status, armed_by_hr_id, armed_at, watch_until, rep_hr_id, rep_lat, rep_lon, rep_accuracy_meters, rep_captured_at, place_id, closed_at, rep_source, seal_report";
const WATCH_ENDED = "This request has ended. Ask for it again.";

/** Who may validate with an uploaded photo: the Super Admin, exactly as he validates on a trusted point. */
export function canValidateWithAdminPhoto(viewer: PhoenixCrmViewer): boolean {
  return canDecideSharedPlaces(viewer);
}

function assertAdminPhotoDecider(viewer: PhoenixCrmViewer): void {
  if (!canValidateWithAdminPhoto(viewer)) {
    throw forbiddenError("Only the Super Admin validates a customer with an uploaded photo.");
  }
}

type WatchRow = {
  id: string;
  customerId: string;
  seatId: string;
  isTest: boolean;
  photoPath: string;
  status: AdminPhotoStatus;
  armedAt: string;
  watchUntil: string;
  repHrId: string | null;
  repLat: number | null;
  repLon: number | null;
  repAccuracyMeters: number | null;
  repCapturedAt: string | null;
  /** `sealed_photo` when the reading is a Phoenix Camera seal's, `live` when the rep sent it. */
  repSource: "live" | "sealed_photo";
  sealReport: FieldCameraReport | null;
};

function watchOf(row: Row): WatchRow {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    seatId: String(row.seat_id),
    isTest: row.is_test === true,
    photoPath: String(row.photo_path ?? ""),
    status: String(row.status) as AdminPhotoStatus,
    armedAt: String(row.armed_at ?? ""),
    watchUntil: String(row.watch_until ?? ""),
    repHrId: typeof row.rep_hr_id === "string" ? row.rep_hr_id : null,
    repLat: numberOrNull(row.rep_lat),
    repLon: numberOrNull(row.rep_lon),
    repAccuracyMeters: numberOrNull(row.rep_accuracy_meters),
    repCapturedAt: typeof row.rep_captured_at === "string" ? row.rep_captured_at : null,
    repSource: row.rep_source === "sealed_photo" ? "sealed_photo" : "live",
    sealReport: row.seal_report && typeof row.seal_report === "object" ? (row.seal_report as FieldCameraReport) : null,
  };
}

async function loadWatch(validationId: unknown): Promise<WatchRow> {
  const id = String(validationId ?? "").toLowerCase();
  if (!isUuid(id)) throw validationError("Reload the page and try again.");
  const { data, error } = await getSupabaseAdmin().from(TABLE).select(WATCH_COLUMNS).eq("id", id).maybeSingle();
  throwIfError(error);
  if (!data) throw notFoundError("This request is no longer open. Reload the page.");
  return watchOf(data as Row);
}

async function loadOpenWatch(customerId: string): Promise<WatchRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(WATCH_COLUMNS)
    .eq("customer_id", customerId)
    .in("status", ["watching", "captured"])
    .limit(1);
  throwIfError(error);
  const row = ((data ?? []) as Row[])[0];
  return row ? watchOf(row) : null;
}

type CustomerRow = { id: string; name: string; seatId: string; isTest: boolean; status: string; listType: string };

async function loadCustomer(customerId: unknown): Promise<CustomerRow> {
  const id = String(customerId ?? "").toLowerCase();
  if (!isUuid(id)) throw validationError("Choose the customer.");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name, seat_id, is_test, status, list_type")
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This customer is not on any list. Reload the page.");
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    seatId: String(row.seat_id),
    isTest: row.is_test === true,
    status: String(row.status ?? ""),
    listType: String(row.list_type ?? ""),
  };
}

export type AdminPhotoLocation = {
  address: string | null;
  brickName: string | null;
  brickDistanceKm: number | null;
  areaName: string | null;
  regionName: string | null;
};

/** What the Super Admin reads about a Phoenix Camera seal that held. */
export type AdminPhotoSealView = {
  takenAtText: string;
  satellites: string;
  phone: string;
  /** Short and stable, so the same phone is recognisable photo after photo. */
  phoneKey: string;
  revocationChecked: boolean;
  warnings: string[];
};

export type AdminPhotoReadingView = {
  /** `sealed_photo`: the reading came inside the Phoenix Camera's seal, not from the rep's List. */
  source: "live" | "sealed_photo";
  seal: AdminPhotoSealView | null;
  repName: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  capturedAtText: string;
  /** The geography the place will be filed in, resolved as a captured place's is. */
  location: AdminPhotoLocation;
};

export type AdminPhotoWatchView = {
  validationId: string;
  status: "watching" | "captured";
  photoPath: string;
  armedAtText: string;
  watchUntilText: string;
  /** False once the watch's time ran out: the rep can no longer send, and "Watch again" restarts it. */
  open: boolean;
  reading: AdminPhotoReadingView | null;
};

export type AdminPhotoState = {
  customerId: string;
  customerName: string;
  status: string;
  /** Why this customer cannot be validated at all (an active place, a pending check, the Archive); null when he can. */
  blockedReason: string | null;
  watch: AdminPhotoWatchView | null;
};

function locationOf(columns: Record<string, unknown>): AdminPhotoLocation {
  return {
    address: (columns.address as string | null) ?? null,
    brickName: (columns.brick_name as string | null) ?? null,
    brickDistanceKm: numberOrNull(columns.brick_distance_km),
    areaName: (columns.area_name as string | null) ?? null,
    regionName: (columns.region_name as string | null) ?? null,
  };
}

async function locationColumnsFor(watch: WatchRow): Promise<Record<string, unknown>> {
  if (watch.repLat === null || watch.repLon === null) throw conflictError("The rep's location has not arrived yet.", "phoenix_crm_admin_photo_no_reading");
  return resolvePlaceLocation(
    { lat: watch.repLat, lon: watch.repLon, accuracyMeters: watch.repAccuracyMeters },
    { areaCodes: await seatAreaCodes(watch.seatId) },
  );
}

async function watchView(watch: WatchRow): Promise<AdminPhotoWatchView> {
  let reading: AdminPhotoReadingView | null = null;
  if (watch.status === "captured" && watch.repLat !== null && watch.repLon !== null) {
    // Resolved only once a reading is there: the screen stops asking the moment it sees one, so the billed
    // address lookup runs once per reading, never once per poll.
    const [names, columns] = await Promise.all([loadPeopleNames([watch.repHrId]), locationColumnsFor(watch)]);
    const report = watch.repSource === "sealed_photo" ? watch.sealReport : null;
    reading = {
      source: watch.repSource,
      seal: report
        ? {
            takenAtText: adminPhotoTimeText(report.takenAtUtc),
            satellites: `${report.satellitesUsed} used of ${report.satellitesSeen} seen`,
            phone: `${report.deviceModel} · Android ${report.androidSdk} · ${report.securityLevel === "StrongBox" ? "StrongBox chip" : "secure chip"}`,
            phoneKey: report.deviceKey.slice(0, 12).toUpperCase(),
            revocationChecked: report.revocation === "checked",
            warnings: report.warnings,
          }
        : null,
      repName: nameOf(names, watch.repHrId, report?.repName ?? "The rep"),
      lat: watch.repLat,
      lon: watch.repLon,
      accuracyMeters: watch.repAccuracyMeters,
      capturedAtText: adminPhotoTimeText(watch.repCapturedAt),
      location: locationOf(columns),
    };
  }
  return {
    validationId: watch.id,
    status: watch.status === "captured" ? "captured" : "watching",
    photoPath: watch.photoPath,
    armedAtText: adminPhotoTimeText(watch.armedAt),
    watchUntilText: adminPhotoTimeText(watch.watchUntil),
    open: watch.repSource === "live" && adminPhotoWatchIsOpen(watch),
    reading,
  };
}

/** The Super Admin's screen: the customer, why he cannot be validated (if so), and the open watch with its reading. */
export async function loadAdminPhotoState(viewer: PhoenixCrmViewer, customerId: unknown): Promise<AdminPhotoState> {
  assertAdminPhotoDecider(viewer);
  const customer = await loadCustomer(customerId);
  territoryForRead(viewer, customer.seatId, customer.isTest);
  const [blockedReason, open] = await Promise.all([blockedReasonFor(customer), loadOpenWatch(customer.id)]);
  return {
    customerId: customer.id,
    customerName: customer.name,
    status: customer.status,
    blockedReason,
    watch: open ? await watchView(open) : null,
  };
}

async function closeOpenWatches(customerId: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ status: "cancelled", closed_at: new Date().toISOString() })
    .eq("customer_id", customerId)
    .in("status", ["watching", "captured"]);
  throwIfError(error);
}

/**
 * Step 1 — the photo is uploaded and the watch switched on. The photo goes through a place slot issued to the
 * Super Admin for the customer's own seat and is consumed at once, so it can never be reused and the path is
 * one every photo reader already understands.
 */
export async function armAdminPhotoValidation(viewer: PhoenixCrmViewer, raw: unknown): Promise<AdminPhotoState> {
  assertAdminPhotoDecider(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const customer = await loadCustomer(body.customerId);
  const { seat } = territoryForRead(viewer, customer.seatId, customer.isTest);
  const blocked = await blockedReasonFor(customer);
  if (blocked) throw conflictError(blocked, "phoenix_crm_admin_photo_blocked");

  const bytes = decodeJpegDataUrl(body.imageDataUrl);
  // A Phoenix Camera file is judged BEFORE anything is uploaded: a seal that does not hold leaves no trace.
  const sealed = hasSealTrailer(bytes) ? await checkFieldCameraPhoto(bytes, { occupantHrIds: seatOccupants(seat) }) : null;
  const uploaded = await uploadPhotoBytesForSlot(
    { hrId: viewer.hrId, seat, isTest: customer.isTest, purpose: "place", cairoToday: viewer.cairoToday },
    bytes,
  );
  await callPhoenixCrm<string>("phoenix_crm_take_photo", {
    p_path: uploaded.path,
    p_hr_id: viewer.hrId,
    p_seat_id: seat.seatId,
    p_purpose: "place",
    p_is_test: customer.isTest,
  });

  await closeOpenWatches(customer.id);
  const base = {
    customer_id: customer.id,
    seat_id: customer.seatId,
    is_test: customer.isTest,
    photo_path: uploaded.path,
    armed_by_hr_id: viewer.hrId.trim().toUpperCase(),
  };
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert(
      sealed
        ? {
            ...base,
            status: "captured",
            // Closed at birth: no rep is asked, and nothing the rep sends can replace the seal's reading.
            watch_until: new Date().toISOString(),
            rep_source: "sealed_photo",
            rep_hr_id: sealed.payload.hrId,
            rep_lat: sealed.payload.lat,
            rep_lon: sealed.payload.lon,
            rep_accuracy_meters: sealed.payload.accuracyMeters,
            rep_captured_at: sealed.payload.takenAtUtc,
            seal_id: sealed.report.sealId,
            seal_report: sealed.report,
          }
        : { ...base, status: "watching", watch_until: adminPhotoWatchUntil() },
    );
  if (error?.code === "23505" && sealed && /seal_idx/.test(`${error.message ?? ""} ${error.details ?? ""}`)) {
    throw conflictError("This sealed photo was already used for a customer. Each photo validates one customer.", "phoenix_crm_admin_photo_seal_used");
  }
  throwIfError(error);
  return loadAdminPhotoState(viewer, customer.id);
}

/** Watch again: the same photo, a fresh window, and the earlier reading cleared so a new one is taken. */
export async function rewatchAdminPhotoValidation(viewer: PhoenixCrmViewer, validationId: unknown): Promise<AdminPhotoState> {
  assertAdminPhotoDecider(viewer);
  const watch = await loadWatch(validationId);
  territoryForRead(viewer, watch.seatId, watch.isTest);
  if (watch.status !== "watching" && watch.status !== "captured") throw conflictError("This request is closed. Upload the photo again.", "phoenix_crm_admin_photo_closed");
  if (watch.repSource === "sealed_photo") {
    throw conflictError("This photo carries its own sealed location. Press Stop and upload again to start over.", "phoenix_crm_admin_photo_sealed");
  }
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ status: "watching", watch_until: adminPhotoWatchUntil(), rep_hr_id: null, rep_lat: null, rep_lon: null, rep_accuracy_meters: null, rep_captured_at: null })
    .eq("id", watch.id)
    .in("status", ["watching", "captured"]);
  throwIfError(error);
  return loadAdminPhotoState(viewer, watch.customerId);
}

/** Stop watching: the watch is closed and the uploaded photo stays on record with it. */
export async function cancelAdminPhotoValidation(viewer: PhoenixCrmViewer, validationId: unknown): Promise<AdminPhotoState> {
  assertAdminPhotoDecider(viewer);
  const watch = await loadWatch(validationId);
  territoryForRead(viewer, watch.seatId, watch.isTest);
  await closeOpenWatches(watch.customerId);
  return loadAdminPhotoState(viewer, watch.customerId);
}

export type AdminPhotoApplied = { placeId: string; customerId: string; event: string; customerName: string; location: AdminPhotoLocation };

/** Step 3 — validate on the uploaded photo and the rep's reading. The geography is resolved again HERE. */
export async function applyAdminPhotoValidation(viewer: PhoenixCrmViewer, validationId: unknown): Promise<AdminPhotoApplied> {
  assertAdminPhotoDecider(viewer);
  const watch = await loadWatch(validationId);
  territoryForRead(viewer, watch.seatId, watch.isTest);
  if (watch.status === "watching") throw conflictError("The rep's location has not arrived yet.", "phoenix_crm_admin_photo_no_reading");
  if (watch.status !== "captured") throw conflictError("This request is closed. Reload the page.", "phoenix_crm_admin_photo_closed");
  // A sealed photo is used within 72 hours of being taken — at Apply too, not only at upload.
  if (watch.repSource === "sealed_photo" && (!watch.repCapturedAt || Date.now() - Date.parse(watch.repCapturedAt) > SEAL_MAX_AGE_HOURS * 3_600_000)) {
    throw conflictError(`This sealed photo is more than ${SEAL_MAX_AGE_HOURS} hours old. Ask the rep for a new one.`, "phoenix_crm_admin_photo_seal_old");
  }
  const customer = await loadCustomer(watch.customerId);
  const blocked = await blockedReasonFor(customer);
  if (blocked) throw conflictError(blocked, "phoenix_crm_admin_photo_blocked");

  const columns = await locationColumnsFor(watch);
  const actor = viewer.hrId.trim().toUpperCase();
  const result = await callPhoenixCrm<Row>("phoenix_crm_validate_with_admin_photo", {
    p: { validation_id: watch.id, actor_hr_id: actor, location: columns },
  });
  const config = await loadPhoenixCrmConfig();
  await restampVisitLocationsQuietly({
    seatId: watch.seatId,
    isTest: watch.isTest,
    customerId: watch.customerId,
    actorHrId: actor,
    settings: config.settings,
    scope: "unplaced",
  });
  // A "validate again" notice an earlier refusal left in the rep's bell is answered now. Never throws.
  await withdrawValidationNotConfirmed(watch.customerId);
  // Validated on one line, validated on the other two of his area too (line-twins.ts).
  await shareAcrossLinesQuietly(watch.customerId);
  return {
    placeId: String(result.place_id),
    customerId: String(result.customer_id),
    event: String(result.event ?? ""),
    customerName: customer.name,
    location: locationOf(columns),
  };
}

// ── The rep's side ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the rep's List tab receives: the customer and whether his reading was sent — nothing more. No watch
 * time, no accuracy, no name of who asked (golden rule #1: nothing on his screen says he is checked).
 */
export type AdminPhotoRepAsk = { askId: string; customerId: string; customerName: string; sent: boolean };

/** The open asks on a territory the viewer validates for — the rep, or a manager of it. */
export async function loadAdminPhotoAsks(viewer: PhoenixCrmViewer, seatId: unknown, test: unknown): Promise<AdminPhotoRepAsk[]> {
  const { seat, isTest } = territoryForValidation(viewer, seatId, readTestFlag(test));
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("id, customer_id, status, watch_until")
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .eq("rep_source", "live")
    .in("status", ["watching", "captured"])
    .gt("watch_until", new Date().toISOString())
    .limit(20);
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];
  const customers = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name")
    .in(
      "id",
      rows.map((row) => String(row.customer_id)),
    );
  throwIfError(customers.error);
  const names = new Map(((customers.data ?? []) as Row[]).map((row) => [String(row.id), String(row.name ?? "")]));
  return rows.map((row) => ({
    askId: String(row.id),
    customerId: String(row.customer_id),
    customerName: names.get(String(row.customer_id)) ?? "",
    sent: row.status === "captured",
  }));
}

/** The rep's Capture-location reading, written onto the open ask. A reading sent again replaces the first. */
export async function sendAdminPhotoReading(viewer: PhoenixCrmViewer, raw: unknown): Promise<AdminPhotoRepAsk[]> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { seat, isTest } = territoryForValidation(viewer, body.seatId, readTestFlag(body.test));
  const watch = await loadWatch(body.askId);
  if (watch.seatId !== seat.seatId || watch.isTest !== isTest) throw forbiddenError("This customer is not on your list.");
  if (watch.repSource !== "live" || !adminPhotoWatchIsOpen(watch)) throw conflictError(WATCH_ENDED, "phoenix_crm_admin_photo_closed");
  const problem = adminPhotoReadingProblem({ lat: body.lat, lon: body.lon, accuracyMeters: body.accuracyMeters });
  if (problem) throw validationError(problem, "phoenix_crm_admin_photo_rough_fix");
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      status: "captured",
      rep_hr_id: viewer.hrId.trim().toUpperCase(),
      rep_lat: Number(body.lat),
      rep_lon: Number(body.lon),
      rep_accuracy_meters: Number(body.accuracyMeters),
      rep_captured_at: new Date().toISOString(),
    })
    .eq("id", watch.id)
    .eq("rep_source", "live")
    .in("status", ["watching", "captured"])
    .gt("watch_until", new Date().toISOString())
    .select("id");
  throwIfError(error);
  if (((data ?? []) as Row[]).length === 0) throw new ApiError(409, "phoenix_crm_admin_photo_closed", WATCH_ENDED);
  return loadAdminPhotoAsks(viewer, seat.seatId, isTest);
}
