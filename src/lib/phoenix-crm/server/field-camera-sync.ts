/**
 * Phoenix CRM — the Phoenix Camera as the rep's OFFLINE visit app (owner, 20 Nov 2026).
 *
 * His words: "each one will log in with his HR ID ... he will have his list, and his plan will show ... planned or
 * unplanned and add new customer ... if he has network the application refuses and tells him go validate in the main
 * account", then "we're not relying on WhatsApp ... the application will synchronize with Phoenix ... the validation
 * will register and the visit will register". He chose the HR ID with his Phoenix password, the sync sending itself
 * when the network returns, no numbers on the rep's screen, and the visit asking what the main account asks.
 *
 * Two doors, both the app's alone (`captureClientOf` = `app`: a bearer token and no session cookie):
 *
 *   - THE PACK (`loadFieldCameraPack`): what the phone keeps for a day with no network — his territory, his
 *     customers with today's plan, the line's products. Read from `loadVisitForm`, the Add Visit form's own read,
 *     so the camera can never offer a customer or a product the main account would not.
 *   - THE SYNC (`syncFieldCameraVisit`): one sealed photo — a visit, a validation alone or a new customer.
 *     Since camera 2.1 (owner, 20 Nov 2026: "Phoenix will not reject anything ... leave the decision to the
 *     decision maker") nothing readable is refused: `receiveCameraItem` (server/camera-items.ts) judges the seal
 *     without throwing and keeps EVERY item waiting on the Super Admin's camera page (owner, 21 Nov 2026: "EVERY
 *     VISIT GOES TO MANUAL REVIEW FIRST"); his Approve records it, up to the rep's allowance for that day. Still
 *     refused: a browser, a caller with no territory of his own,
 *     a file with no seal, and a photo whose seal names no customer.
 *     A resend of the same sync is the same item (the seal's visit id), never a second.
 *
 * 🔴 Golden rule #1: what goes back to the phone is "received", whatever became of it; no distance, accuracy,
 * board, limit or check is named.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { hasSealTrailer } from "@/lib/phoenix-crm/field-camera/seal-format";
import { CUSTOMER_TYPES, DOCTOR_SPECIALITIES, TYPES_WITH_SPECIALITY } from "@/lib/phoenix-crm/speciality-list";
import { readTestFlag, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { CAMERA_RECEIVED, receiveCameraItem, signCameraFile } from "@/lib/phoenix-crm/server/camera-items";
import type { CaptureClient } from "@/lib/phoenix-crm/server/capture-client";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadVisitForm } from "@/lib/phoenix-crm/server/visits";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** A sealed photo is a JPEG of a few megabytes; anything far past that is not one. */
export const FIELD_CAMERA_SYNC_MAX_BYTES = 15 * 1024 * 1024;

export type FieldCameraPackCustomer = {
  customerId: string;
  name: string;
  listType: string;
  speciality: string | null;
  plannedToday: boolean;
  visitedToday: boolean;
  /** He has a place already; a visit to one who has none validates him on the photo. */
  validated: boolean;
  /** What he discussed last time, so the form fills it in as the main account's does. */
  lastProducts: string[];
};

/** Somebody the rep may name on "Who was on the visit", exactly as the main account's form offers them. */
export type FieldCameraPackPerson = { hrId: string; name: string; side: "manager" | "product" };

export type FieldCameraPack = {
  seatId: string;
  hrId: string;
  repName: string;
  /** The visit day the pack was read for (until 02:00 the day that just ended). */
  visitDay: string;
  products: string[];
  /** The territory's managers, nearest first, then the line's product managers. */
  people: FieldCameraPackPerson[];
  customers: FieldCameraPackCustomer[];
  /** What "Add a new customer" offers (camera 2.2.0): Phoenix CRM's own lists. */
  newCustomerOptions: { customerTypes: string[]; specialities: string[]; typesWithSpeciality: string[]; listTypes: string[] };
  /** The newest Phoenix Camera the Super Admin published, for the "Update the app" button; null when none is. */
  latestApp: FieldCameraRelease | null;
};

export type FieldCameraRelease = { versionCode: number; versionName: string; sha256: string; sizeBytes: number; url: string };

/** A day is long enough for the phone to fetch the file whenever the rep presses the button. */
const RELEASE_URL_SECONDS = 24 * 60 * 60;

/** The newest published release with a link the phone can download it from, or null. Never throws: the pack must load. */
export async function loadLatestFieldCameraRelease(): Promise<FieldCameraRelease | null> {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("phoenix_crm_field_camera_releases")
      .select("version_code, version_name, sha256, size_bytes, storage_path")
      .order("version_code", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwIfError(error);
    const row = data as Record<string, unknown> | null;
    if (!row) return null;
    const url = await signCameraFile(String(row.storage_path), RELEASE_URL_SECONDS);
    if (!url) return null;
    return {
      versionCode: Number(row.version_code),
      versionName: String(row.version_name),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      url,
    };
  } catch {
    return null;
  }
}

function assertApp(client: CaptureClient): void {
  // A browser has no offline queue and no sealed camera; the door is not there for it.
  if (client !== "app") throw notFoundError("Not found.");
}

export async function loadFieldCameraPack(viewer: PhoenixCrmViewer, raw: { seatId: unknown }, client: CaptureClient): Promise<FieldCameraPack> {
  assertApp(client);
  const own = viewer.ownTerritories[0]?.seatId ?? null;
  const { seat } = territoryForRepWrite(viewer, raw.seatId ?? own, false);
  const form = await loadVisitForm(viewer, { seatId: seat.seatId, test: null });
  if (form.enteredAs !== "rep") throw notFoundError("Not found.");
  const [names, latestApp] = await Promise.all([loadPeopleNames([viewer.hrId]), loadLatestFieldCameraRelease()]);
  return {
    seatId: seat.seatId,
    hrId: viewer.hrId.trim().toUpperCase(),
    repName: nameOf(names, viewer.hrId, viewer.hrId),
    visitDay: viewer.visitDay,
    products: form.products,
    people: [
      ...form.managers.map((person) => ({ hrId: person.hrId, name: person.name, side: "manager" as const })),
      ...form.productManagers.map((person) => ({ hrId: person.hrId, name: person.name, side: "product" as const })),
    ],
    customers: form.customers
      .filter((customer) => !customer.outside)
      .map((customer) => ({
        customerId: customer.customerId,
        name: customer.name,
        listType: customer.listType,
        speciality: customer.speciality,
        plannedToday: customer.plannedToday,
        visitedToday: customer.visitedToday,
        validated: customer.places.length > 0,
        lastProducts: customer.lastVisit?.products ?? [],
      })),
    newCustomerOptions: {
      // A pharmacy is added by its name alone in Phoenix CRM itself, never through the camera's new customer.
      customerTypes: CUSTOMER_TYPES.filter((type) => type !== "Pharmacy"),
      specialities: [...DOCTOR_SPECIALITIES],
      typesWithSpeciality: [...TYPES_WITH_SPECIALITY],
      listTypes: ["AM", "PM"],
    },
    latestApp,
  };
}

export type FieldCameraSyncResult = typeof CAMERA_RECEIVED;

function decodeSealedFile(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw validationError("The photo did not arrive. The app sends it again.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > FIELD_CAMERA_SYNC_MAX_BYTES) throw validationError("The photo did not arrive whole. The app sends it again.");
  if (!hasSealTrailer(bytes)) throw validationError("This photo carries no Phoenix Camera seal.", "phoenix_crm_field_camera_unsealed");
  return new Uint8Array(bytes);
}

export async function syncFieldCameraVisit(viewer: PhoenixCrmViewer, raw: unknown, client: CaptureClient): Promise<FieldCameraSyncResult> {
  assertApp(client);
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const own = viewer.ownTerritories[0]?.seatId ?? null;
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId ?? own, readTestFlag(body.test));
  const bytes = decodeSealedFile(body.file);
  const draft = (body.visit && typeof body.visit === "object" ? body.visit : {}) as Record<string, unknown>;
  return receiveCameraItem({ viewer, seat, isTest, bytes, draft });
}
