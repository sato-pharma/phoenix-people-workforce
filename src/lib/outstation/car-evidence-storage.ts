import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { OutstationCarEvidenceMetadata } from "@/lib/outstation/types";

export const OUTSTATION_EVIDENCE_BUCKET = "outstation-evidence";

const CAR_EVIDENCE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;

export type ParsedCarEvidenceImage = {
  bytes: Buffer;
  contentType: "image/jpeg";
};

function sanitizeStorageSegment(value: string | null | undefined, fallback: string) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function buildOutstationCarEvidenceImagePath(metadata: OutstationCarEvidenceMetadata) {
  const employeeHrId = sanitizeStorageSegment(metadata.employeeHrId, "unknown-employee");
  const draftOrRequestId = sanitizeStorageSegment(
    metadata.requestDraftId ?? metadata.requestId,
    "unknown-request",
  );

  return `car/${employeeHrId}/${draftOrRequestId}.jpg`;
}

export function parseOutstationCarEvidenceImageDataUrl(dataUrl: string): ParsedCarEvidenceImage {
  const match = /^data:(image\/jpeg);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Car evidence image must be a compressed JPEG captured inside the app.");
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    throw new Error("Car evidence image is empty. Capture the photo again.");
  }

  if (bytes.length > CAR_EVIDENCE_MAX_UPLOAD_BYTES) {
    throw new Error("Car evidence image is too large. Capture the photo again.");
  }

  return {
    bytes,
    contentType: "image/jpeg",
  };
}

export async function uploadOutstationCarEvidenceImage(params: {
  imageDataUrl: string;
  metadata: OutstationCarEvidenceMetadata;
}) {
  const parsed = parseOutstationCarEvidenceImageDataUrl(params.imageDataUrl);
  const path = buildOutstationCarEvidenceImagePath(params.metadata);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.storage
    .from(OUTSTATION_EVIDENCE_BUCKET)
    .upload(path, parsed.bytes, {
      cacheControl: "31536000",
      contentType: parsed.contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Unable to store car evidence image: ${error.message}`);
  }

  return path;
}

export async function deleteOutstationCarEvidenceImage(path: string | null) {
  if (!path) return;

  const supabase = getSupabaseAdmin();
  await supabase.storage.from(OUTSTATION_EVIDENCE_BUCKET).remove([path]);
}

export async function createOutstationCarEvidenceSignedUrl(path: string | null) {
  if (!path) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(OUTSTATION_EVIDENCE_BUCKET)
    .createSignedUrl(path, CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS);

  if (error) return null;
  return data.signedUrl;
}
