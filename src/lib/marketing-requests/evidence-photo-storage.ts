import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { licenseVerdictColumns } from "@/lib/venues/pharmacy-license-verdict-columns";
import { PRIVATE_FILE_CACHE_CONTROL_SECONDS } from "@/lib/uploads/private-file-cache";
import {
  parsePharmacyLicenseDataUrl,
  PHARMACY_LICENSE_BUCKET,
  type PharmacyLicenseContentType,
} from "@/lib/venues/pharmacy-license";

/**
 * Where marketing customer/pharmacy live-capture photos are actually retained.
 *
 * MUST stay equal to `public.marketing_evidence_files.storage_bucket`'s column default — a row
 * written with one bucket and read from another resolves to nothing, which is the exact failure
 * this module exists to end. Private bucket: the images carry a GPS stamp of a real shop front,
 * so they are only ever reachable through a short-lived signed URL minted server-side.
 */
export const MARKETING_EVIDENCE_BUCKET = "marketing-evidence";

/** Matches the outstation car-evidence cap. The capture is a quality-0.86 canvas JPEG. */
const MARKETING_EVIDENCE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Same TTL as `CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS` — one approval sitting, not a shareable link. */
const MARKETING_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;

export type MarketingEvidenceEntityType = "customer" | "pharmacy";

export type ParsedMarketingEvidencePhoto = {
  bytes: Buffer;
  contentType: "image/jpeg";
};

export type MarketingEvidencePhotoRecord = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  entityId: string;
  entityType: MarketingEvidenceEntityType;
  hasTimestamp: boolean;
  originalFileName: string | null;
  uploadedByHrId: string | null;
};

/**
 * JPEG-only, live-capture-only. Deliberately the same shape as
 * `parseOutstationCarEvidenceImageDataUrl`: a photo pasted from the gallery arrives as some other
 * MIME type and must fail on exactly the same rule, because the whole claim being made by this
 * evidence is "taken at this place, at this time".
 */
export function parseMarketingEvidencePhotoDataUrl(dataUrl: string): ParsedMarketingEvidencePhoto {
  const match = /^data:(image\/jpeg);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Live capture photo must be a compressed JPEG taken inside the app.");
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    throw new Error("Live capture photo is empty. Take the photo again.");
  }

  if (bytes.length > MARKETING_EVIDENCE_MAX_UPLOAD_BYTES) {
    throw new Error("Live capture photo is too large. Take the photo again.");
  }

  return { bytes, contentType: "image/jpeg" };
}

/**
 * Keyed on the entity's own uuid, so a customer and a pharmacy can never collide and a row can
 * never hold a path belonging to a different record. The id only exists after the insert, which is
 * why the upload runs after the entity row is written rather than alongside it.
 */
export function buildMarketingEvidencePhotoPath(input: {
  entityId: string;
  entityType: MarketingEvidenceEntityType;
}) {
  const entityId = String(input.entityId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!entityId) {
    throw new Error("Cannot store a live capture photo without the record it belongs to.");
  }

  return `${input.entityType}/${entityId}.jpg`;
}

/**
 * Store the bytes AND index them in `marketing_evidence_files` in one call.
 *
 * The two must not drift: an object with no row is unfindable, and a row with no object is the very
 * lie this replaces. If the index write fails the just-uploaded object is removed before the error
 * propagates, so the bucket never accumulates orphans a later reader would have no way to explain.
 */
export async function storeMarketingEvidencePhoto(params: {
  imageDataUrl: string;
  record: MarketingEvidencePhotoRecord;
  supabase?: SupabaseClient;
}): Promise<string> {
  const parsed = parseMarketingEvidencePhotoDataUrl(params.imageDataUrl);
  const path = buildMarketingEvidencePhotoPath({
    entityId: params.record.entityId,
    entityType: params.record.entityType,
  });
  const supabase = params.supabase ?? getSupabaseAdmin();

  const upload = await supabase.storage
    .from(MARKETING_EVIDENCE_BUCKET)
    .upload(path, parsed.bytes, {
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
      contentType: parsed.contentType,
      // true: the path is keyed on the entity id, and a re-validation of the same record should
      // replace its photo rather than fail. A brand-new record cannot collide with anything.
      upsert: true,
    });

  if (upload.error) {
    throw new Error(`Unable to store the live capture photo: ${upload.error.message}`);
  }

  const indexed = await supabase.from("marketing_evidence_files").insert({
    captured_accuracy_meters: params.record.capturedAccuracyMeters,
    captured_address: params.record.capturedAddress,
    captured_at: params.record.capturedAt,
    captured_latitude: params.record.capturedLatitude,
    captured_longitude: params.record.capturedLongitude,
    content_type: parsed.contentType,
    entity_id: params.record.entityId,
    entity_type: params.record.entityType,
    evidence_type: "location_photo",
    has_timestamp: params.record.hasTimestamp,
    original_file_name: params.record.originalFileName,
    storage_bucket: MARKETING_EVIDENCE_BUCKET,
    storage_path: path,
    uploaded_by_hr_id: params.record.uploadedByHrId,
  });

  if (indexed.error) {
    await supabase.storage.from(MARKETING_EVIDENCE_BUCKET).remove([path]);
    throw new Error(`Unable to record the live capture photo: ${indexed.error.message}`);
  }

  return path;
}

/**
 * The `evidence_type` a pharmacy trade licence is filed under.
 *
 * A constant rather than a literal at each call site because THREE places must agree on it — the
 * writer, the reader, and the migration's CHECK constraint — and a typo in any one of them stores a
 * licence nothing can find again. Deliberately NOT `'other'`: every existing reader filters on
 * `location_photo`, so a licence hiding under `other` would be invisible by luck rather than by
 * rule, and the next reader that forgets the filter would render a licence where a shop front
 * belongs.
 */
export const MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE = "pharmacy_license";

export type MarketingPharmacyLicenseFile = {
  contentType: PharmacyLicenseContentType;
  signedUrl: string;
  uploadedAt: string | null;
};

/**
 * Store a pharmacy trade licence for one venue, and index it beside the shop-front photos.
 *
 * Reuses the index table and the signed-URL read path exactly as they stand — the only thing that
 * distinguishes a licence from a location photo is `evidence_type` and the file extension.
 * `upsert: true` for the same reason the photo path uses it: re-attaching a licence to the same
 * venue should REPLACE it, not fail.
 *
 * THE BUCKET IS THE ONE THING NOT REUSED. `marketing-evidence` is provisioned JPEG-only with a 2MB
 * ceiling, and that allow-list is a second wall behind the live-capture parser — a gallery upload
 * cannot reach storage even if a caller got past the service. Widening it to admit a PDF would take
 * that wall down for every shop-front photo too, so the licence goes to `pharmacy-licenses`
 * instead. `storage_bucket` is a per-row column, so the index table carries the difference itself
 * and every existing photo row is untouched.
 *
 * Note the path deliberately carries the extension of the file that was actually sent. A licence is
 * routinely a PDF, and serving one from a `.jpg` path makes browsers download it instead of opening
 * it, which is the difference between an approver reading the document and an approver giving up.
 */
export async function storeMarketingPharmacyLicense(params: {
  fileDataUrl: string;
  originalFileName: string | null;
  pharmacyId: string;
  supabase?: SupabaseClient;
  uploadedByHrId: string | null;
}): Promise<string> {
  const parsed = parsePharmacyLicenseDataUrl(params.fileDataUrl);
  const entityId = String(params.pharmacyId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!entityId) {
    throw new Error("Cannot store a pharmacy licence without the venue it belongs to.");
  }

  // A path of its own for EVERY file. It used to be `pharmacy/<id>-license.<ext>` with `upsert`, so a
  // second licence of the same type overwrote the first in storage - and when that submission then
  // failed and was rolled back, the rollback removed the path, deleting the licence that had been on
  // file BEFORE the submission. Unique paths make a rollback delete only what this run created.
  const path = `pharmacy/${entityId}-license-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${parsed.extension}`;
  const supabase = params.supabase ?? getSupabaseAdmin();

  const upload = await supabase.storage.from(PHARMACY_LICENSE_BUCKET).upload(path, parsed.bytes, {
    cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
    contentType: parsed.contentType,
    upsert: false,
  });
  if (upload.error) {
    throw new Error(`Unable to store the pharmacy licence: ${upload.error.message}`);
  }

  // Every capture column stays null on purpose. A licence is a DOCUMENT, not a claim about where
  // anyone stood — writing this submission's GPS onto it would manufacture a provenance the file
  // does not have, and a later reader would have no way to tell it from a real capture.
  const indexed = await supabase.from("marketing_evidence_files").insert({
    content_type: parsed.contentType,
    entity_id: params.pharmacyId,
    entity_type: "pharmacy" satisfies MarketingEvidenceEntityType,
    evidence_type: MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE,
    has_timestamp: false,
    original_file_name: params.originalFileName,
    storage_bucket: PHARMACY_LICENSE_BUCKET,
    storage_path: path,
    uploaded_by_hr_id: params.uploadedByHrId,
  });

  if (indexed.error) {
    await supabase.storage.from(PHARMACY_LICENSE_BUCKET).remove([path]);
    throw new Error(`Unable to record the pharmacy licence: ${indexed.error.message}`);
  }

  // A verdict is about ONE document. When a different file replaces the licence, the old answer
  // ("confirmed to match") would stand beside a licence nobody has compared - so it goes back to
  // "not checked yet". Only a row that actually holds a verdict is touched.
  const verdictCleared = await supabase
    .from("marketing_pharmacies")
    .update(licenseVerdictColumns({ actorHrId: null, matchesSign: null, now: new Date().toISOString() }))
    .eq("id", params.pharmacyId)
    .not("license_name_matches_sign", "is", null);
  if (verdictCleared.error) {
    // The file is stored and indexed; only the stale verdict could not be cleared. Say so rather than
    // leave an old "matches" standing silently beside a new document.
    throw new Error(`Unable to reset the licence check for the new file: ${verdictCleared.error.message}`);
  }

  return path;
}

/**
 * Signed licence URLs for MANY venues at once, keyed by pharmacy id.
 *
 * Same shape and same failure posture as `loadMarketingEvidencePhotosByEntityIds`: one index read,
 * one batch signing call, and an empty map on any failure — an approval screen must open whether or
 * not the licences resolve.
 */
export async function loadMarketingPharmacyLicensesByPharmacyIds(params: {
  pharmacyIds: string[];
  supabase?: SupabaseClient;
}): Promise<Map<string, MarketingPharmacyLicenseFile>> {
  const found = new Map<string, MarketingPharmacyLicenseFile>();
  const pharmacyIds = [...new Set(params.pharmacyIds.filter(Boolean))];
  if (pharmacyIds.length === 0) return found;

  const client = params.supabase ?? getSupabaseAdmin();
  type Row = {
    content_type?: string | null;
    created_at?: string | null;
    entity_id?: string | null;
    storage_path?: string | null;
  };
  const newestByPharmacy = new Map<string, Row>();

  // Chunked at 50. A PostgREST `.in()` carrying several hundred ids puts every one of them in the
  // URL and comes back `{ data: [], error: null }` past some length — an empty set indistinguishable
  // from "none of these venues has a licence", which would silently erase the evidence from a
  // screen listing a large customer database.
  for (let index = 0; index < pharmacyIds.length; index += 50) {
    const { data, error } = await client
      .from("marketing_evidence_files")
      .select("entity_id, storage_path, content_type, created_at")
      .eq("entity_type", "pharmacy")
      .eq("evidence_type", MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE)
      .in("entity_id", pharmacyIds.slice(index, index + 50))
      .order("created_at", { ascending: false });
    if (error || !data) return found;
    // Newest-first, so the FIRST row seen per venue is the one to keep: re-attaching a licence
    // writes a second index row rather than editing the first.
    for (const row of data as Row[]) {
      const entityId = row.entity_id ? String(row.entity_id) : "";
      if (entityId && row.storage_path && !newestByPharmacy.has(entityId)) {
        newestByPharmacy.set(entityId, row);
      }
    }
  }
  if (newestByPharmacy.size === 0) return found;

  const entries = [...newestByPharmacy.entries()];
  const signed = await client.storage
    .from(PHARMACY_LICENSE_BUCKET)
    .createSignedUrls(
      entries.map(([, row]) => String(row.storage_path)),
      MARKETING_EVIDENCE_SIGNED_URL_TTL_SECONDS,
    );
  if (signed.error || !signed.data) return found;

  signed.data.forEach((result, index) => {
    const entry = entries[index];
    if (!entry || !result?.signedUrl || result.error) return;
    found.set(entry[0], {
      // Defaulted rather than left nullable: the column has never been null on a row this function
      // wrote, and a caller deciding "render an image or offer a PDF link" needs an answer, not a
      // third case. JPEG is the safe default — it renders, and a mislabelled PDF fails visibly.
      contentType: (entry[1].content_type as PharmacyLicenseContentType | null) ?? "image/jpeg",
      signedUrl: result.signedUrl,
      uploadedAt: entry[1].created_at ?? null,
    });
  });

  return found;
}

/**
 * Undo a partial multi-customer save. Best-effort: a failed cleanup must not mask the real error.
 *
 * BOTH BUCKETS are swept, because one save can write a shop-front photo to `marketing-evidence` and
 * a licence to `pharmacy-licenses`, and the caller collects the two into one list of paths. Asking
 * each bucket to remove every path is not wasteful: a path that is not in a bucket is a no-op, and
 * the alternative — threading a bucket alongside every path through the save — buys nothing but a
 * second place to get it wrong. The index delete is keyed on `storage_path` and already covers both.
 */
export async function deleteMarketingEvidencePhotos(paths: string[], supabase?: SupabaseClient) {
  if (paths.length === 0) return;

  const client = supabase ?? getSupabaseAdmin();
  await client.storage.from(MARKETING_EVIDENCE_BUCKET).remove(paths).catch(() => undefined);
  await client.storage.from(PHARMACY_LICENSE_BUCKET).remove(paths).catch(() => undefined);
  await client.from("marketing_evidence_files").delete().in("storage_path", paths);
}

/**
 * The approver's read path. Returns null rather than throwing, because a decision screen must
 * always open — an unreachable photo degrades to "no image retained", never to a dead page.
 */
export async function createMarketingEvidencePhotoSignedUrl(
  path: string | null | undefined,
  supabase?: SupabaseClient,
): Promise<string | null> {
  if (!path) return null;

  const client = supabase ?? getSupabaseAdmin();
  const { data, error } = await client.storage
    .from(MARKETING_EVIDENCE_BUCKET)
    .createSignedUrl(path, MARKETING_EVIDENCE_SIGNED_URL_TTL_SECONDS);

  if (error) return null;
  return data?.signedUrl ?? null;
}

/**
 * Newest retained photo for one customer or pharmacy, as a ready-to-render signed URL.
 *
 * Reads `marketing_evidence_files` rather than `evidence_photo_name`, which is the whole point:
 * the file table only ever has a row when bytes were genuinely written, so a hit here is proof and
 * a miss is an honest absence. Any failure degrades to null for the same reason as above.
 */
export async function loadMarketingEvidencePhoto(params: {
  entityId: string | null | undefined;
  entityType: MarketingEvidenceEntityType;
  supabase?: SupabaseClient;
}): Promise<{ capturedAt: string | null; signedUrl: string } | null> {
  if (!params.entityId) return null;

  const client = params.supabase ?? getSupabaseAdmin();
  const { data, error } = await client
    .from("marketing_evidence_files")
    .select("storage_path, captured_at")
    .eq("entity_type", params.entityType)
    .eq("entity_id", params.entityId)
    .eq("evidence_type", "location_photo")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as { captured_at?: string | null; storage_path?: string | null };
  const signedUrl = await createMarketingEvidencePhotoSignedUrl(row.storage_path, client);
  if (!signedUrl) return null;

  return { capturedAt: row.captured_at ?? null, signedUrl };
}

/**
 * One retained live-capture photo: where to fetch it, when it was taken, and WHERE THE CAMERA WAS.
 *
 * The coordinates are the photo’s own reading at the shutter, not the venue’s location fix - see
 * `src/lib/evidence/capture-trust.ts` for why the two must never be conflated.
 */
export type MarketingEvidencePhotoIndexEntry = {
  accuracyMeters: number | null;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  signedUrl: string;
};

/** Postgres hands `double precision` back as a number OR a string depending on the driver path. */
function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


/**
 * Signed photo URLs for MANY entities at once, keyed by entity id.
 *
 * The per-entity `loadMarketingEvidencePhoto` would be an N+1 on a request targeting several
 * pharmacies — one index read and one signing round-trip each. This does one index read and one
 * batch signing call instead. Entities with no retained photo are simply absent from the map, so a
 * caller reading `map.get(id)` gets `undefined` and renders the honest "no image" branch.
 *
 * Degrades to an empty map on any failure: an approval screen must open regardless.
 */
export async function loadMarketingEvidencePhotosByEntityIds(params: {
  entityIds: string[];
  entityType: MarketingEvidenceEntityType;
  supabase?: SupabaseClient;
}): Promise<Map<string, MarketingEvidencePhotoIndexEntry>> {
  const found = new Map<string, MarketingEvidencePhotoIndexEntry>();
  const entityIds = [...new Set(params.entityIds.filter(Boolean))];
  if (entityIds.length === 0) return found;

  const client = params.supabase ?? getSupabaseAdmin();
  const { data, error } = await client
    .from("marketing_evidence_files")
    .select("entity_id, storage_path, captured_at, captured_latitude, captured_longitude, captured_accuracy_meters")
    .eq("entity_type", params.entityType)
    .eq("evidence_type", "location_photo")
    .in("entity_id", entityIds)
    .order("created_at", { ascending: false });

  if (error || !data) return found;

  type Row = {
    captured_accuracy_meters?: number | string | null;
    captured_at?: string | null;
    captured_latitude?: number | string | null;
    captured_longitude?: number | string | null;
    entity_id?: string | null;
    storage_path?: string | null;
  };
  // Newest-first ordering above means the FIRST row seen per entity is the one to keep; a
  // re-validated record can legitimately have more than one file row.
  const newestByEntity = new Map<string, Row>();
  for (const row of data as Row[]) {
    const entityId = row.entity_id ? String(row.entity_id) : "";
    if (entityId && row.storage_path && !newestByEntity.has(entityId)) {
      newestByEntity.set(entityId, row);
    }
  }
  if (newestByEntity.size === 0) return found;

  const entries = [...newestByEntity.entries()];
  const signed = await client.storage
    .from(MARKETING_EVIDENCE_BUCKET)
    .createSignedUrls(entries.map(([, row]) => String(row.storage_path)), MARKETING_EVIDENCE_SIGNED_URL_TTL_SECONDS);

  if (signed.error || !signed.data) return found;

  signed.data.forEach((result, index) => {
    const entry = entries[index];
    if (!entry || !result?.signedUrl || result.error) return;
    found.set(entry[0], {
      accuracyMeters: numberOrNull(entry[1].captured_accuracy_meters),
      capturedAt: entry[1].captured_at ?? null,
      // The PHOTO’s own fix. Null on every row written before 2026-09-29, and on any capture
      // whose shutter could not read a position - which means NOT MEASURED, never “same place”.
      latitude: numberOrNull(entry[1].captured_latitude),
      longitude: numberOrNull(entry[1].captured_longitude),
      signedUrl: result.signedUrl,
    });
  });

  return found;
}
