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
 *   - THE SYNC (`syncFieldCameraVisit`): one sealed photo and the visit it was taken for.
 *       1. The seal is judged in full (`checkFieldCameraPhoto`): the picture, the phone's chip, our app, no fake
 *          location, Google's revocation list, the rep. It must name THIS rep, and its signed visit block names the
 *          territory, the customer, the visit's own id and the offline clock — nothing in the body can move them.
 *       2. A customer with no place is validated on the seal (`validateWithRepSeal`), exactly as the Super Admin's
 *          sealed upload is, with the rep as the actor.
 *       3. The visit is saved by `saveVisit`, unchanged, as the app: the seal's position is its reading, and the
 *          seal's offline clock (`offline-clock.ts`, anchor plus uptime, never a phone timestamp) dates it.
 *     A resend of the same sync is the same visit (same uuid) and the same seal (`allowResend`), never a second.
 *
 * 🔴 Golden rule #1: what goes back to the phone is "recorded" or the refusal's plain words; no distance, accuracy,
 * board or check is named. The integrity signals are recorded above the rep by `saveVisit` as for any visit.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { hasSealTrailer } from "@/lib/phoenix-crm/field-camera/seal-format";
import { seatOccupants } from "@/lib/phoenix-crm/scope";
import { readTestFlag, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { validateWithRepSeal } from "@/lib/phoenix-crm/server/admin-photo";
import type { CaptureClient } from "@/lib/phoenix-crm/server/capture-client";
import { checkFieldCameraPhoto } from "@/lib/phoenix-crm/server/field-camera";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadVisitForm, saveVisit } from "@/lib/phoenix-crm/server/visits";

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
};

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
  const names = await loadPeopleNames([viewer.hrId]);
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
  };
}

export type FieldCameraSyncResult = {
  visitId: string;
  /** This sync validated the customer on the photo. */
  validated: boolean;
  /** The visit was already recorded by an earlier send of the same sync. */
  duplicate: boolean;
};

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
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const bytes = decodeSealedFile(body.file);
  const sealed = await checkFieldCameraPhoto(bytes, { occupantHrIds: seatOccupants(seat), allowResend: true });
  const { payload } = sealed;
  const visit = payload.visit;
  if (!visit) throw validationError("This photo was not taken for a visit. Take it again from the customer.", "phoenix_crm_field_camera_no_visit");
  if (payload.hrId !== viewer.hrId.trim().toUpperCase()) {
    throw validationError("This photo was sealed under somebody else's login.", "phoenix_crm_admin_photo_seal_not_rep");
  }
  if (visit.seatId !== seat.seatId) throw validationError("This photo was taken for another territory.", "phoenix_crm_field_camera_other_seat");

  const validation = sealed.alreadyUsed
    ? { validated: false }
    : await validateWithRepSeal(viewer, { seat, isTest, customerId: visit.customerId, bytes, sealed });

  const draft = (body.visit && typeof body.visit === "object" ? body.visit : {}) as Record<string, unknown>;
  const saved = await saveVisit(
    viewer,
    {
      ...draft,
      // Everything that says who, where and when comes from the signed seal, never from the body.
      id: visit.visitId,
      seatId: seat.seatId,
      test: isTest,
      customerId: visit.customerId,
      lat: payload.lat,
      lon: payload.lon,
      accuracyMeters: payload.accuracyMeters,
      deviceMocked: payload.mock,
      offline: visit.offline,
    },
    client,
  );
  return { visitId: visit.visitId, validated: validation.validated, duplicate: Boolean((saved as { duplicate?: boolean }).duplicate) };
}
