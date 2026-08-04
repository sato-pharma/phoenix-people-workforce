import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  OutstationCarEvidenceMetadata,
  OutstationTicketAttachmentMetadata,
} from "@/lib/outstation/types";

export const OUTSTATION_EVIDENCE_BUCKET = "outstation-evidence";

const CAR_EVIDENCE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TICKET_ATTACHMENT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;
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

/** A ticket attachment before the employee/request identity is attached. */
export type OutstationTicketAttachmentUploadInput = Omit<
  OutstationTicketAttachmentUpload,
  "employeeHrId" | "requestDraftId"
>;

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

/**
 * The DEPARTURE photo's storage path. Kept under a sibling `departure/` prefix rather than
 * overwriting the arrival photo's `car/<hr>/<draft>.jpg` — the two must coexist, and the arrival
 * path is keyed on the draft id with `upsert: true`, so reusing it would silently replace the
 * arrival photo with the departure one and leave the request with two gates satisfied by a single
 * image. Keyed on the REQUEST id, because by the time a departure photo is taken the request
 * exists and its draft id is no longer the thing that identifies it.
 */
export function buildOutstationDepartureEvidenceImagePath(input: {
  employeeHrId: string;
  requestId: string | number;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const requestId = sanitizeStorageSegment(String(input.requestId), "unknown-request");
  return `departure/${employeeHrId}/${requestId}.jpg`;
}

export async function uploadOutstationDepartureEvidenceImage(params: {
  employeeHrId: string;
  imageDataUrl: string;
  requestId: string | number;
}) {
  // Same JPEG-only, 2MB, live-capture parser as the arrival photo — a departure photo pasted
  // from the gallery must fail on exactly the same rule.
  const parsed = parseOutstationCarEvidenceImageDataUrl(params.imageDataUrl);
  const path = buildOutstationDepartureEvidenceImagePath({
    employeeHrId: params.employeeHrId,
    requestId: params.requestId,
  });

  const { error } = await getSupabaseAdmin()
    .storage.from(OUTSTATION_EVIDENCE_BUCKET)
    .upload(path, parsed.bytes, {
      cacheControl: "31536000",
      contentType: parsed.contentType,
      // false: a departure photo is captured once. Allowing an overwrite would let a later,
      // more convenient photo quietly replace the one taken at the destination.
      upsert: false,
    });

  if (error) {
    throw new Error(`Unable to store the departure photo: ${error.message}`);
  }

  return path;
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

/**
 * Decode a client-supplied ticket data URL (`data:<mime>;base64,<payload>`) into
 * an upload-ready attachment. Validates the MIME type and 5MB size cap up front
 * so an invalid ticket is rejected before any storage write. Mirrors the
 * car-evidence data-URL parser so the manager submit route stays JSON.
 */
export function parseOutstationTicketAttachmentDataUrl(input: {
  dataUrl: string;
  fileName: string;
}): OutstationTicketAttachmentUploadInput {
  const match = /^data:([a-z0-9.+/-]+);base64,([a-zA-Z0-9+/=]+)$/i.exec(input.dataUrl.trim());
  if (!match) {
    throw new Error("Ticket attachment must be an uploaded PDF, JPG, or PNG file.");
  }

  const contentType = match[1].toLowerCase();
  if (!TICKET_ATTACHMENT_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error("Ticket attachment must be a PDF, JPG, or PNG file.");
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    throw new Error("Ticket attachment is empty. Upload a valid ticket attachment.");
  }
  if (bytes.length > TICKET_ATTACHMENT_MAX_UPLOAD_BYTES) {
    throw new Error("Ticket attachment is too large. Maximum size is 5MB.");
  }

  return {
    bytes,
    contentType,
    fileName: input.fileName.trim() || "ticket-attachment",
    size: bytes.length,
  };
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

/**
 * Sign a batch of paths in the outstation-evidence bucket (ticket attachments live here too).
 * Returns a URL per input path, preserving order; a path that fails to sign yields null.
 */
export async function createOutstationEvidenceSignedUrls(paths: string[]): Promise<Array<string | null>> {
  if (paths.length === 0) return [];

  const supabase = getSupabaseAdmin();
  return Promise.all(
    paths.map(async (path) => {
      if (!path) return null;
      const { data, error } = await supabase.storage
        .from(OUTSTATION_EVIDENCE_BUCKET)
        .createSignedUrl(path, CAR_EVIDENCE_SIGNED_URL_TTL_SECONDS);
      return error ? null : data.signedUrl;
    }),
  );
}
