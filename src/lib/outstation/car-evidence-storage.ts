import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  OutstationCarEvidenceMetadata,
  OutstationTicketAttachmentMetadata,
} from "@/lib/outstation/types";

export const OUTSTATION_EVIDENCE_BUCKET = "outstation-evidence";

const CAR_EVIDENCE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TICKET_ATTACHMENT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;
const CAR_EVIDENCE_ALLOWED_CONTENT_TYPES = new Set(["image/jpeg"]);
const TICKET_ATTACHMENT_ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export type ParsedCarEvidenceImage = {
  bytes: Buffer;
  contentType: "image/jpeg";
};

export type OutstationTicketAttachmentUpload = {
  bytes: Buffer;
  contentType: string;
  employeeHrId: string;
  fileName: string;
  requestDraftId: string;
  size: number;
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

export function buildOutstationTicketAttachmentPath(input: {
  employeeHrId: string;
  fileName: string;
  index: number;
  requestDraftId: string;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const draftId = sanitizeStorageSegment(input.requestDraftId, "unknown-request");
  const index = Math.max(1, input.index);
  const fileName = sanitizeStorageSegment(input.fileName, `attachment-${index}`);

  return `tickets/${employeeHrId}/${draftId}/${index}-${fileName}`;
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

function assertOutstationCarEvidenceBytes(bytes: Buffer) {
  if (bytes.length === 0) {
    throw new Error("Car evidence image is empty. Capture the photo again.");
  }

  if (bytes.length > CAR_EVIDENCE_MAX_UPLOAD_BYTES) {
    throw new Error("Car evidence image is too large. Capture the photo again.");
  }
}

export async function uploadOutstationCarEvidenceImageFromBytes(params: {
  bytes: Buffer;
  metadata: OutstationCarEvidenceMetadata;
}) {
  assertOutstationCarEvidenceBytes(params.bytes);
  const path = buildOutstationCarEvidenceImagePath(params.metadata);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.storage.from(OUTSTATION_EVIDENCE_BUCKET).upload(path, params.bytes, {
    cacheControl: "31536000",
    contentType: "image/jpeg",
    upsert: true,
  });

  if (error) {
    throw new Error(`Unable to store car evidence image: ${error.message}`);
  }

  return path;
}

function parseCarEvidenceMetadataFromImage(imageFile: File) {
  if (!CAR_EVIDENCE_ALLOWED_CONTENT_TYPES.has(imageFile.type)) {
    throw new Error("Car evidence image must be a JPEG photo.");
  }
}

export async function uploadOutstationCarEvidenceImage(params: {
  imageDataUrl: string;
  metadata: OutstationCarEvidenceMetadata;
}) {
  const parsed = parseOutstationCarEvidenceImageDataUrl(params.imageDataUrl);
  return uploadOutstationCarEvidenceImageFromBytes({
    bytes: parsed.bytes,
    metadata: params.metadata,
  });
}

export async function uploadOutstationCarEvidenceFile(params: {
  imageFile: File;
  metadata: OutstationCarEvidenceMetadata;
}) {
  parseCarEvidenceMetadataFromImage(params.imageFile);
  const bytes = Buffer.from(await params.imageFile.arrayBuffer());
  return uploadOutstationCarEvidenceImageFromBytes({ bytes, metadata: params.metadata });
}

export async function uploadOutstationTicketAttachments(
  attachments: OutstationTicketAttachmentUpload[],
): Promise<OutstationTicketAttachmentMetadata[]> {
  const supabase = getSupabaseAdmin();
  const uploaded: OutstationTicketAttachmentMetadata[] = [];

  try {
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.bytes.length === 0) {
        throw new Error("Ticket attachment is empty. Upload a valid ticket attachment.");
      }

      if (attachment.bytes.length > TICKET_ATTACHMENT_MAX_UPLOAD_BYTES) {
        throw new Error("Ticket attachment is too large. Maximum size is 5MB.");
      }

      if (!TICKET_ATTACHMENT_ALLOWED_CONTENT_TYPES.has(attachment.contentType)) {
        throw new Error("Ticket attachment must be a PDF, JPG, or PNG file.");
      }

      const path = buildOutstationTicketAttachmentPath({
        employeeHrId: attachment.employeeHrId,
        fileName: attachment.fileName,
        index: index + 1,
        requestDraftId: attachment.requestDraftId,
      });

      const { error } = await supabase.storage
        .from(OUTSTATION_EVIDENCE_BUCKET)
        .upload(path, attachment.bytes, {
          cacheControl: "31536000",
          contentType: attachment.contentType,
          upsert: false,
        });

      if (error) {
        throw new Error(`Unable to store ticket attachment: ${error.message}`);
      }

      uploaded.push({
        contentType: attachment.contentType,
        name: attachment.fileName,
        path,
        size: attachment.size,
        uploadedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    await deleteOutstationTicketAttachments(
      uploaded.map((attachment) => attachment.path),
    );
    throw error;
  }

  return uploaded;
}

export async function deleteOutstationCarEvidenceImage(path: string | null) {
  if (!path) return;

  const supabase = getSupabaseAdmin();
  await supabase.storage.from(OUTSTATION_EVIDENCE_BUCKET).remove([path]);
}

export async function deleteOutstationTicketAttachments(paths: string[]) {
  if (paths.length === 0) return;

  const supabase = getSupabaseAdmin();
  await supabase.storage.from(OUTSTATION_EVIDENCE_BUCKET).remove(paths);
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
