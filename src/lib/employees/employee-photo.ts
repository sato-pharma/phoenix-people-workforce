// Employee self-service profile photos — storage + resolution.
//
// Uploaded photos live in the private "employee-photos" Storage bucket and are
// referenced by `employees.photo_path`. The bucket is private, so images are
// served back through the same-origin route /api/employees/[hrId]/photo (which
// streams via the service-role client). Resolution order anywhere a photo is
// shown is: uploaded photo -> bundled static photo -> initials (caller-handled).
//
// THE STORED OBJECT IS THE PORTRAIT. Every upload — self-service, HR's, the joining
// form's — passes through `normalizeEmployeePhoto` (photo-normalize.ts) before it is
// stored: upright, letterbox bars stripped, cut to the identity card's 0.785 : 1 frame.
// The frames that draw it never crop a black bar again (owner, 2026-11-01).
//
// The cached photo map lets any server surface decide "does this HR ID have an
// uploaded photo?" with a single small query (mirrors the role-override cache).
//
// NOT guarded with `import "server-only"` (tried 2026-07-25, reverted): that package
// always throws unless a bundler substitutes a no-op for server builds, which Next.js
// does but this repo's plain-Node test runner (tests/run-tests.ts) does not — 25+ test
// files transitively import this module via employee-directory.ts and all failed. The
// node:crypto import below already fails any accidental client bundle at webpack build
// time on its own (that's the mechanism, not a friendly message, but it's a hard stop).

import crypto from "node:crypto";

import { normalizeHrId } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { normalizeEmployeePhoto } from "@/lib/employees/photo-normalize";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const EMPLOYEE_PHOTOS_BUCKET = "employee-photos";
export const MAX_EMPLOYEE_PHOTO_BYTES = 5 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_MAP_TTL_MS = 30_000;

export function isEmployeePhotoStorageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isAllowedPhotoContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase()));
}

function extensionForContentType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

type PhotoMapEntry = { path: string; updatedAt: string | null };

let photoMapCache: { value: Map<string, PhotoMapEntry>; expiresAt: number } | null = null;

// Same in-flight-dedupe pattern as inFlightDirectory in employee-directory.ts: concurrent
// cache-miss callers (e.g. the directory service and a portal page loading at once) share one
// query instead of each issuing their own.
let inFlightPhotoMap: Promise<Map<string, PhotoMapEntry>> | null = null;

export function invalidateEmployeePhotoMap(): void {
  photoMapCache = null;
}

/** The map, or null when it could not be read — a null is answered but never cached. */
async function fetchEmployeePhotoMap(): Promise<Map<string, PhotoMapEntry> | null> {
  const map = new Map<string, PhotoMapEntry>();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, photo_path, photo_updated_at")
      .not("photo_path", "is", null);

    if (error || !Array.isArray(data)) return null;
    for (const row of data as Array<{
      hr_id: string | null;
      photo_path: string | null;
      photo_updated_at: string | null;
    }>) {
      const key = normalizeHrId(row.hr_id);
      if (!key || !row.photo_path) continue;
      map.set(key, { path: row.photo_path, updatedAt: row.photo_updated_at });
    }
  } catch {
    // Pre-migration or a transient failure: no uploaded photos for THIS load, and nothing cached,
    // so the next load reads again instead of showing initials for the next minute.
    return null;
  }

  return map;
}

/**
 * Cached map of normalized HR ID -> uploaded photo metadata. Defensive: if the
 * column/bucket does not exist yet (pre-migration) the query fails and we fall
 * back to an empty map so nothing in the read path breaks.
 */
export async function getEmployeePhotoMap(): Promise<Map<string, PhotoMapEntry>> {
  const now = Date.now();
  if (photoMapCache && photoMapCache.expiresAt > now) {
    return photoMapCache.value;
  }

  if (!inFlightPhotoMap) {
    inFlightPhotoMap = fetchEmployeePhotoMap()
      .then((map) => {
        if (!map) return new Map<string, PhotoMapEntry>();
        photoMapCache = { value: map, expiresAt: Date.now() + PHOTO_MAP_TTL_MS };
        return map;
      })
      .finally(() => {
        inFlightPhotoMap = null;
      });
  }

  return inFlightPhotoMap;
}

function cacheBust(updatedAt: string | null): string {
  if (!updatedAt) return "";
  const ts = Date.parse(updatedAt);
  return Number.isFinite(ts) ? `?v=${ts}` : "";
}

function photoRouteFor(hrId: string, updatedAt: string | null): string {
  return `/api/employees/${encodeURIComponent(String(hrId).trim())}/photo${cacheBust(updatedAt)}`;
}

/**
 * Returns the same-origin route URL for an employee's uploaded photo, or null
 * when the employee has not uploaded one (caller should then fall back to the
 * bundled static photo / initials).
 */
export async function uploadedEmployeePhotoUrl(hrId: string | null | undefined): Promise<string | null> {
  const key = normalizeHrId(hrId);
  if (!key) return null;
  const map = await getEmployeePhotoMap();
  const entry = map.get(key);
  return entry ? photoRouteFor(String(hrId), entry.updatedAt) : null;
}

/**
 * Fully-resolved photo src for an HR ID using a pre-loaded map: uploaded photo
 * route -> bundled static photo -> null. Synchronous so it can be called inside
 * render loops once the map is loaded.
 */
export function resolveEmployeePhotoSrc(
  hrId: string | null | undefined,
  photoMap: Map<string, PhotoMapEntry>,
): string | null {
  const key = normalizeHrId(hrId);
  if (key) {
    const entry = photoMap.get(key);
    if (entry) return photoRouteFor(String(hrId), entry.updatedAt);
  }
  return employeeProfileImageForHrId(hrId);
}

/** Parses + validates an image upload from a multipart request body. */
export async function readImagePayload(request: Request): Promise<{ bytes: Buffer; contentType: string }> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("An image file is required.");
  }
  const contentType = file.type || "";
  if (!isAllowedPhotoContentType(contentType)) {
    throw new Error("Unsupported image type. Please use JPG, PNG, or WebP.");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("The uploaded image is empty.");
  }
  if (bytes.length > MAX_EMPLOYEE_PHOTO_BYTES) {
    throw new Error("Image is too large. The maximum size is 5 MB.");
  }
  return { bytes, contentType };
}

/** Uploads a new photo for an HR ID, records it, and cleans up the old object. */
export async function uploadEmployeePhoto(
  hrId: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ path: string }> {
  const normalized = normalizeHrId(hrId);
  if (!normalized) throw new Error("A valid HR ID is required.");
  if (!isAllowedPhotoContentType(contentType)) {
    throw new Error("Unsupported image type. Please use JPG, PNG, or WebP.");
  }
  if (bytes.length > MAX_EMPLOYEE_PHOTO_BYTES) {
    throw new Error("Image is too large. The maximum size is 5 MB.");
  }

  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupError } = await supabase
    .from("employees")
    .select("hr_id, photo_path")
    .eq("hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase())
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error(`Unable to load employee: ${lookupError.message}`);
  if (!existing) throw new Error(`Employee ${hrId} was not found.`);

  // The portrait cut is best-effort: bytes sharp cannot read are stored as they were sent, so a
  // photo is never refused for what the cut cannot do.
  const portrait = await normalizeEmployeePhoto(bytes);
  const stored = portrait
    ? { bytes: portrait.bytes, contentType: portrait.contentType }
    : { bytes, contentType };

  const path = `${normalized}/${crypto.randomUUID()}.${extensionForContentType(stored.contentType)}`;
  const { error: uploadError } = await supabase.storage
    .from(EMPLOYEE_PHOTOS_BUCKET)
    .upload(path, stored.bytes, { cacheControl: "31536000", contentType: stored.contentType, upsert: false });
  if (uploadError) throw new Error(`Unable to store photo: ${uploadError.message}`);

  const { error: updateError } = await supabase
    .from("employees")
    .update({ photo_path: path, photo_updated_at: new Date().toISOString() })
    .eq("hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase());
  if (updateError) {
    await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).remove([path]).catch(() => {});
    throw new Error(`Unable to update employee photo: ${updateError.message}`);
  }

  const previousPath = (existing as { photo_path?: string | null }).photo_path ?? null;
  if (previousPath && previousPath !== path) {
    await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).remove([previousPath]).catch(() => {});
  }

  invalidateEmployeePhotoMap();
  return { path };
}

/** Clears an employee's uploaded photo, reverting to the static photo / initials. */
export async function clearEmployeePhoto(hrId: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupError } = await supabase
    .from("employees")
    .select("photo_path")
    .eq("hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase())
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error(`Unable to load employee: ${lookupError.message}`);

  const previousPath = (existing as { photo_path?: string | null } | null)?.photo_path ?? null;

  const { error: updateError } = await supabase
    .from("employees")
    .update({ photo_path: null, photo_updated_at: new Date().toISOString() })
    .eq("hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase());
  if (updateError) throw new Error(`Unable to clear employee photo: ${updateError.message}`);

  if (previousPath) {
    await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).remove([previousPath]).catch(() => {});
  }
  invalidateEmployeePhotoMap();
}

/**
 * The validator for an employee's current uploaded photo, or null when there is none. Every upload
 * stores a new object path (a fresh UUID) and a removal clears it, so the path's last segment changes
 * exactly when the picture does. Read from the cached photo map, so a browser asking "is my copy
 * still current?" is answered without downloading the picture from storage.
 */
export async function employeePhotoEtag(hrId: string): Promise<string | null> {
  const key = normalizeHrId(hrId);
  if (!key) return null;
  const entry = (await getEmployeePhotoMap()).get(key);
  if (!entry) return null;
  const version = entry.path.split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "") ?? "";
  return version ? `"${version}"` : null;
}

/** Downloads the raw bytes for an employee's uploaded photo (service-role). */
export async function streamEmployeePhoto(
  hrId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const key = normalizeHrId(hrId);
  if (!key) return null;
  const map = await getEmployeePhotoMap();
  const entry = map.get(key);
  if (!entry) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(EMPLOYEE_PHOTOS_BUCKET).download(entry.path);
  if (error || !data) return null;
  const bytes = Buffer.from(await data.arrayBuffer());
  return { bytes, contentType: data.type || "image/jpeg" };
}
