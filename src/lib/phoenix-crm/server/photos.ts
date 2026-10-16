/**
 * Phoenix CRM — live photos.
 *
 * A photo never passes through the app. The phone asks for an upload slot the moment the photo is
 * taken (not when the camera opens, so a camera opened and closed leaves nothing behind, and the
 * phone's shutter time is compared with a server time taken seconds later); the server records the
 * path (who, which territory, what for, test or real) and returns a signed upload URL for that one
 * path; the phone uploads the JPEG straight to the private bucket.
 * A save then consumes the slot in the database (phoenix_crm_take_photo): it refuses a path the server
 * did not issue to that person for that territory, a path already used, a slot older than 2 hours
 * (enough to wait for the doctor and save; never enough to date the next morning's visit to the night
 * before), or an object that never arrived. The slot's issue time is the capture time a visit is
 * dated by.
 *
 * Display is batch-signed for ten minutes, for people who can read the territory.
 */

import crypto from "node:crypto";

import { ApiError, validationError } from "@/lib/http/api-errors";
import { readTestFlag, territoryForValidation, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";

/** Far above a real day (a rep validates or visits a few dozen customers), low enough to stop a loop. */
const SLOTS_PER_HOUR = 90;
const SIGNED_URL_SECONDS = 600;
const SIGN_BATCH_MAX = 120;

export type PhotoPurpose = "place" | "visit";

function storageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "territory";
}

export type PhotoSlot = { path: string; signedUrl: string; token: string; issuedAt: string };

type PhotoSlotInput = {
  hrId: string;
  seat: OrgSeat;
  isTest: boolean;
  purpose: PhotoPurpose;
  cairoToday: string;
};

/** The hourly allowance, then the path a new slot will hold. Refuses past the allowance. */
async function nextSlotPath(input: PhotoSlotInput): Promise<string> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await getSupabaseAdmin()
    .from("phoenix_crm_photo_uploads")
    .select("path", { count: "exact", head: true })
    .eq("issued_to_hr_id", input.hrId)
    // Counted per world: a test account files its slots under the rep it mirrors, and its try-outs
    // must never use up that rep's own hourly allowance.
    .eq("is_test", input.isTest)
    .gte("issued_at", since);
  throwIfError(recent.error);
  if ((recent.count ?? 0) >= SLOTS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", "You took many photos in the last hour. Wait a few minutes and try again.");
  }

  const [year, month] = input.cairoToday.split("-");
  return `${input.isTest ? "test/" : ""}${storageSegment(input.seat.seatId)}/${year}/${month}/${input.purpose}/${crypto.randomUUID()}.jpg`;
}

/** The slot row: who, which territory, what for, test or real, and the issue time a save is dated by. */
async function insertSlotRow(input: PhotoSlotInput, path: string, issuedAt: string) {
  return getSupabaseAdmin().from("phoenix_crm_photo_uploads").insert({
    path,
    issued_to_hr_id: input.hrId,
    seat_id: input.seat.seatId,
    purpose: input.purpose,
    is_test: input.isTest,
    issued_at: issuedAt,
  });
}

export async function issuePhotoSlot(input: PhotoSlotInput): Promise<PhotoSlot> {
  const path = await nextSlotPath(input);
  const issuedAt = new Date().toISOString();

  // 🔴 THE ROW AND THE SIGNED URL ARE ASKED FOR TOGETHER (Phoenix CRM performance audit, 2026-10-16).
  // The path is made here, so signing it needs nothing from the row, and the rep pressing the shutter
  // waited for one round trip and then another for no reason. What must not change is what he gets
  // back when the row fails: settled rather than raced, so the ROW's error is checked first and a
  // signed URL for a path with no slot behind it is never handed out — exactly as when signing only
  // began after the insert. A URL signed for a failed row is simply dropped; with no slot row, a save
  // can never consume it.
  const [slot, signing] = await Promise.allSettled([
    insertSlotRow(input, path, issuedAt),
    getSupabaseAdmin().storage.from(PHOENIX_CRM_PHOTO_BUCKET).createSignedUploadUrl(path),
  ]);
  if (slot.status === "rejected") throw slot.reason;
  throwIfError(slot.value.error);
  if (signing.status === "rejected") throw signing.reason;
  const { data, error } = signing.value;
  if (error || !data) throw error ?? new Error("The photo upload could not be prepared.");
  return { path, signedUrl: data.signedUrl, token: data.token, issuedAt };
}

/**
 * Who may take this photo, for which territory and world — the gate both slot doors share.
 *
 * A place photo for whoever may validate the list — the territory's rep, and since 2026-10-02 a manager
 * of it (owner's pick) — and a visit photo for whoever may enter the territory's visits.
 *
 * 🔴 The place slot must match `validateCustomer`'s own gate (`territoryForValidation`). With the
 * narrower one it refused the camera, which is the FIRST step of validating, so a manager would have
 * been offered a Validate button that could not take a photo.
 */
function photoSlotInput(viewer: PhoenixCrmViewer, raw: unknown): PhotoSlotInput {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const purpose: PhotoPurpose | null = body.purpose === "place" ? "place" : body.purpose === "visit" ? "visit" : null;
  if (!purpose) throw validationError("Reload the page and open the camera again.");
  const test = readTestFlag(body.test);
  const { seat, isTest } = purpose === "place" ? territoryForValidation(viewer, body.seatId, test) : territoryForVisit(viewer, body.seatId, test);
  return { hrId: viewer.hrId, seat, isTest, purpose, cairoToday: viewer.cairoToday };
}

/** An upload slot for the person about to take the photo — see `photoSlotInput` for who may. */
export async function requestPhotoSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<PhotoSlot> {
  return issuePhotoSlot(photoSlotInput(viewer, raw));
}

/** The bucket refuses anything larger; the same 2 MB ceiling as every other Phoenix evidence photo. */
const PHOTO_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** A `data:image/jpeg;base64,…` URL, tolerant of the base64 having no line breaks. */
const DATA_URL_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

/**
 * The native app's photo upload, decoded and stored server-side.
 *
 * The web page uploads straight to the signed slot from the browser (`sendToSlot` PUTs the JPEG to
 * `slot.signedUrl`). React Native cannot PUT the raw bytes of a stamped photo to that URL reliably —
 * this build has no `expo-file-system`, and `fetch` will not stream a `file://` body to a third-party
 * URL — so the phone sends the stamped JPEG as a base64 data URL to this function and the SERVER
 * stores it. Every guarantee the slot carries is kept: the same gate and the same slot row as
 * `requestPhotoSlot` issue the path (who, which territory, what for, test or real, one slot-per-hour
 * budget), and the returned `path`/`issuedAt` are exactly what a later save consumes with
 * `phoenix_crm_take_photo`. Only the last hop moves from the phone to this server, which changes
 * nothing about what is stored or how a visit is dated — the slot's issue time is still the capture
 * time. Guarded by the same `phoenix_crm:create` permission as the slot route.
 *
 * 🔴 NO SIGNED URL ON THIS PATH (Phoenix CRM performance audit, 2026-10-16). Until then the server
 * signed an upload URL for itself and then PUT up to 2 MB to it — a round trip to mint a token for a
 * door it already holds the key to. It now writes the object with the service client, to the SAME
 * path, with the same content type, the same refusal to overwrite, the same cache metadata the
 * browser's PUT leaves, and the same two refusals the rep read before.
 */
export async function uploadPhotoDirect(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ path: string; issuedAt: string }> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const match = DATA_URL_PATTERN.exec(String(body.imageDataUrl ?? "").replace(/\s+/g, ""));
  if (!match) throw validationError("The photo could not be read. Take it again.");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0) throw validationError("The photo is empty. Take it again.");
  if (bytes.length > PHOTO_MAX_UPLOAD_BYTES) {
    throw validationError("The photo is larger than Phoenix accepts. Take it again.");
  }

  // The same gate the browser's slot route uses — a place photo for whoever may validate, a visit photo
  // for whoever may enter this territory's visits — then the allowance and the slot row. The row is
  // written BEFORE the bytes, as it always was, so a refused or failed row never leaves an object in
  // the bucket that no slot can account for.
  const input = photoSlotInput(viewer, body);
  const path = await nextSlotPath(input);
  const issuedAt = new Date().toISOString();
  const { error: slotError } = await insertSlotRow(input, path, issuedAt);
  throwIfError(slotError);

  let stored: { error: unknown };
  try {
    stored = await getSupabaseAdmin()
      .storage.from(PHOENIX_CRM_PHOTO_BUCKET)
      .upload(path, bytes, {
        contentType: "image/jpeg",
        upsert: false,
        // The browser's PUT names no cache-control, and Storage records `no-cache` for such an
        // upload; the client library would otherwise stamp its own one-hour default on this path's
        // objects only.
        headers: { "cache-control": "no-cache" },
      });
  } catch {
    throw new ApiError(502, "photo_upload_failed", "The photo could not be uploaded. Take it again where the signal is better.");
  }
  if (stored.error) {
    const failure = stored.error as { status?: unknown; statusCode?: unknown; message?: unknown };
    // No HTTP status means the bucket never answered — a dropped connection, which is what a failed
    // `fetch` meant on the old path, and it keeps that path's words.
    if (typeof failure.status !== "number") {
      throw new ApiError(502, "photo_upload_failed", "The photo could not be uploaded. Take it again where the signal is better.");
    }
    // A retried upload whose earlier answer was lost: the object already sits at the path. The web
    // client treats the same 409 as success, and so does the save, which only needs the object to exist.
    const duplicate =
      failure.status === 409 || String(failure.statusCode ?? "") === "409" || /already exists|duplicate/i.test(String(failure.message ?? ""));
    if (!duplicate) {
      throw new ApiError(502, "photo_upload_failed", "The photo did not upload. Take it again.");
    }
  }

  return { path, issuedAt };
}

/** The territory a stored photo path belongs to, and whether it is a test photo. */
export function photoPathTerritory(path: string): { seatSegment: string; isTest: boolean } | null {
  const parts = path.split("/");
  const isTest = parts[0] === "test";
  const rest = isTest ? parts.slice(1) : parts;
  if (rest.length !== 5 || !/^\d{4}$/.test(rest[1]) || !/^\d{2}$/.test(rest[2]) || !["place", "visit"].includes(rest[3])) return null;
  if (!/^[0-9a-f-]{36}\.jpg$/.test(rest[4])) return null;
  return { seatSegment: rest[0], isTest };
}

/** Ten-minute display URLs for the photos a viewer may see. Paths outside their scope are refused. */
export async function signPhotoPaths(viewer: PhoenixCrmViewer, rawPaths: unknown): Promise<Record<string, string>> {
  const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (paths.length === 0) return {};
  if (paths.length > SIGN_BATCH_MAX) throw validationError(`Ask for at most ${SIGN_BATCH_MAX} photos at a time.`);

  const readable = new Set(
    (viewer.isSuperAdmin ? viewer.org.territories : [...viewer.scopeTerritories, ...viewer.ownTerritories]).map((seat) => storageSegment(seat.seatId)),
  );
  for (const path of paths) {
    const owner = photoPathTerritory(path);
    // A test account sees the test photos of its own reach, as it sees every other test entry there.
    if (!owner || (owner.isTest && !viewer.isSuperAdmin && !viewer.isTestPersona) || !readable.has(owner.seatSegment)) {
      throw new ApiError(403, "forbidden", "A photo you asked for is outside your scope.");
    }
  }

  const { data, error } = await getSupabaseAdmin().storage.from(PHOENIX_CRM_PHOTO_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  if (error) throw error;
  const signed: Record<string, string> = {};
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) signed[entry.path] = entry.signedUrl;
  }
  return signed;
}

/** When the server issued a slot (the capture time), for comparing the phone's clock. */
export async function photoSlotIssuedAt(path: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_photo_uploads").select("issued_at").eq("path", path).maybeSingle();
  throwIfError(error);
  const issuedAt = (data as { issued_at?: unknown } | null)?.issued_at;
  return typeof issuedAt === "string" ? issuedAt : null;
}

/**
 * The raw bytes of one stored photo, for the server's own reading of it.
 *
 * THIS FILE OPENS THE BUCKET AND ITS CALLERS DO NOT — the same rule the voice notes keep. A second
 * module reaching into the bucket on its own is how a path check gets skipped once and then copied,
 * so anything that needs pixels asks here and gets bytes back.
 *
 * Unsigned and unscoped on purpose, and that is safe for exactly one reason: the only caller is the
 * nightly sweep, which runs as the system over photos it found in the database rather than over a
 * path somebody asked for. Never wire this to a request — `signPhotoPaths` is the scoped read, and
 * it is scoped for a reason.
 *
 * Returns null rather than throwing on a missing or unreadable object: a photo that cannot be read
 * is a fact to record, never a reason to take a batch down.
 */
export async function downloadPhoto(path: string): Promise<Uint8Array | null> {
  const { data, error } = await getSupabaseAdmin().storage.from(PHOENIX_CRM_PHOTO_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * The bytes of one PLACE photo this person's own slot issued, for the server's own reading of it
 * inside their request.
 *
 * 🔴 THE EXCEPTION TO `downloadPhoto`'s RULE IS DOCUMENTED HERE, AT THE NEW DOOR, AND NOT BY
 * LOOSENING THE OLD ONE. `downloadPhoto` stays unsigned, unscoped and nightly-only, because its
 * safety rests entirely on nobody choosing its argument. This one is reachable from a request, so it
 * carries a scope STRONGER than `signPhotoPaths`': the path must parse as a `place` slot, its seat
 * segment must be the seat doing the saving, its test flag must match, and a `phoenix_crm_photo_uploads`
 * row must exist for that exact path issued to THIS hr id. A path the server did not hand this person
 * for this territory never reaches the bucket, so there is nothing to probe with.
 *
 * Needed because the signboard reading happens while the rep is still at the clinic, before the place
 * row exists — so there is no row to find the photo from, only the path he is saving.
 *
 * Null rather than throwing, every time: a photo that cannot be read is a fact to record, never a
 * reason to refuse a rep standing at a doorway.
 */
export async function downloadIssuedPlacePhoto(input: {
  path: string;
  seatId: string;
  hrId: string;
  isTest: boolean;
}): Promise<Uint8Array | null> {
  const path = String(input.path ?? "").trim();
  if (!path) return null;

  // The path's own shape first, so a malformed one never reaches a query.
  const owner = photoPathTerritory(path);
  if (!owner || owner.isTest !== input.isTest) return null;
  if (owner.seatSegment !== storageSegment(input.seatId)) return null;

  // Then the slot row, which is the real authority: it holds the seat, the purpose, the test flag and
  // who it was issued to as COLUMNS, so none of them has to be inferred from the path's text.
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_photo_uploads")
    .select("path, issued_to_hr_id, seat_id, purpose, is_test")
    .eq("path", path)
    .eq("issued_to_hr_id", input.hrId)
    .eq("seat_id", input.seatId)
    .eq("purpose", "place")
    .eq("is_test", input.isTest)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;

  return downloadPhoto(path);
}

/**
 * The bytes of a POLYCLINIC's timetable photo — the one the building keeps, which any rep on that
 * seat may be reading rather than only the one who took it.
 *
 * 🔴 WHY IT IS NOT `downloadIssuedPlacePhoto` WITH A WIDER ARGUMENT. That one requires
 * `issued_to_hr_id = this rep`, and from 2026-10-10 the timetable is photographed ONCE for the
 * building (owner: "ask him for only one timetable, not for every doctor") — so the second doctor is
 * seated by reading a photograph a DIFFERENT rep uploaded, on a different day. Passed through the
 * old door that reads as "no row", which returns null, which the schedule check reports as
 * `unjudged("no_bytes")`: a verdict silently lost rather than a refusal anybody could see. So the
 * one condition that has to go is named here, at its own door, and nothing else is loosened.
 *
 * WHAT STILL HOLDS, and it is everything else: the path must parse as a `place` slot, its seat
 * segment must be the seat doing the saving, its test flag must match, and a
 * `phoenix_crm_photo_uploads` row must exist for that exact path, on that seat, with that purpose
 * and that test flag. A path the server never issued for THIS territory still never reaches the
 * bucket — the caller may only name a photo its own seat uploaded.
 *
 * 🔴 AND THE CALLER MAY NOT NAME IT FREELY: `effectiveSeatedPhoto` resolves a reused timetable from
 * the VENUE's stored `schedule_photo_path`, never from the phone, so the only path that ever reaches
 * this function is one the venue itself holds.
 */
export async function downloadVenueTimetablePhoto(input: {
  path: string;
  seatId: string;
  isTest: boolean;
}): Promise<Uint8Array | null> {
  const path = String(input.path ?? "").trim();
  if (!path) return null;

  const owner = photoPathTerritory(path);
  if (!owner || owner.isTest !== input.isTest) return null;
  if (owner.seatSegment !== storageSegment(input.seatId)) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_photo_uploads")
    .select("path, seat_id, purpose, is_test")
    .eq("path", path)
    .eq("seat_id", input.seatId)
    .eq("purpose", "place")
    .eq("is_test", input.isTest)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;

  return downloadPhoto(path);
}
