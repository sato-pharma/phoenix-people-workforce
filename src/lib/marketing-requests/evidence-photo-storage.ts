import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/lib/supabase/server";

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
      cacheControl: "31536000",
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

/** Undo a partial multi-customer save. Best-effort: a failed cleanup must not mask the real error. */
export async function deleteMarketingEvidencePhotos(paths: string[], supabase?: SupabaseClient) {
  if (paths.length === 0) return;

  const client = supabase ?? getSupabaseAdmin();
  await client.storage.from(MARKETING_EVIDENCE_BUCKET).remove(paths).catch(() => undefined);
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
}): Promise<Map<string, { capturedAt: string | null; signedUrl: string }>> {
  const found = new Map<string, { capturedAt: string | null; signedUrl: string }>();
  const entityIds = [...new Set(params.entityIds.filter(Boolean))];
  if (entityIds.length === 0) return found;

  const client = params.supabase ?? getSupabaseAdmin();
  const { data, error } = await client
    .from("marketing_evidence_files")
    .select("entity_id, storage_path, captured_at")
    .eq("entity_type", params.entityType)
    .eq("evidence_type", "location_photo")
    .in("entity_id", entityIds)
    .order("created_at", { ascending: false });

  if (error || !data) return found;

  type Row = { captured_at?: string | null; entity_id?: string | null; storage_path?: string | null };
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
    found.set(entry[0], { capturedAt: entry[1].captured_at ?? null, signedUrl: result.signedUrl });
  });

  return found;
}
