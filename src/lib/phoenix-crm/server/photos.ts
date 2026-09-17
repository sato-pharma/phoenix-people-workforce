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
import { readTestFlag, territoryForRepWrite, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
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

export async function issuePhotoSlot(input: {
  hrId: string;
  seat: OrgSeat;
  isTest: boolean;
  purpose: PhotoPurpose;
  cairoToday: string;
}): Promise<PhotoSlot> {
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supabase
    .from("phoenix_crm_photo_uploads")
    .select("path", { count: "exact", head: true })
    .eq("issued_to_hr_id", input.hrId)
    .gte("issued_at", since);
  throwIfError(recent.error);
  if ((recent.count ?? 0) >= SLOTS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", "You took many photos in the last hour. Wait a few minutes and try again.");
  }

  const [year, month] = input.cairoToday.split("-");
  const path = `${input.isTest ? "test/" : ""}${storageSegment(input.seat.seatId)}/${year}/${month}/${input.purpose}/${crypto.randomUUID()}.jpg`;
  const issuedAt = new Date().toISOString();
  const { error: slotError } = await supabase.from("phoenix_crm_photo_uploads").insert({
    path,
    issued_to_hr_id: input.hrId,
    seat_id: input.seat.seatId,
    purpose: input.purpose,
    is_test: input.isTest,
    issued_at: issuedAt,
  });
  throwIfError(slotError);

  const { data, error } = await supabase.storage.from(PHOENIX_CRM_PHOTO_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("The photo upload could not be prepared.");
  return { path, signedUrl: data.signedUrl, token: data.token, issuedAt };
}

/**
 * An upload slot for the person about to take the photo: a place photo for the territory's rep (who
 * validates the list), a visit photo for whoever may enter the territory's visits.
 */
export async function requestPhotoSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<PhotoSlot> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const purpose: PhotoPurpose | null = body.purpose === "place" ? "place" : body.purpose === "visit" ? "visit" : null;
  if (!purpose) throw validationError("Reload the page and open the camera again.");
  const test = readTestFlag(body.test);
  const { seat, isTest } = purpose === "place" ? territoryForRepWrite(viewer, body.seatId, test) : territoryForVisit(viewer, body.seatId, test);
  return issuePhotoSlot({ hrId: viewer.hrId, seat, isTest, purpose, cairoToday: viewer.cairoToday });
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
    if (!owner || (owner.isTest && !viewer.isSuperAdmin) || !readable.has(owner.seatSegment)) {
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
