import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  sanitizeStorageSegment,
  vacationAttachmentBucket,
  type VacationAttachmentUpload,
} from "@/lib/vacation/service";

export type PendingVacationAttachmentKind = "sick" | "compensatory";

const pendingAttachmentRoot = "pending";
const unknownEmployeeSegment = "unknown-employee";
// The per-upload id is crypto.randomUUID(): lowercase hex in the 8-4-4-4-12 shape.
const pendingUploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPendingVacationAttachmentKind(value: unknown): value is PendingVacationAttachmentKind {
  return value === "sick" || value === "compensatory";
}

// sanitizeStorageSegment keeps dots, so "." and ".." come through it untouched, and each is a path
// step rather than a name. Never mint one and never accept one.
function isDotsOnly(segment: string) {
  return /^\.+$/.test(segment);
}

function pendingSegment(value: string | null | undefined, fallback: string) {
  const segment = sanitizeStorageSegment(value, fallback);
  return isDotsOnly(segment) ? fallback : segment;
}

function isPendingSegment(segment: string) {
  return segment !== "" && !isDotsOnly(segment) && sanitizeStorageSegment(segment, "") === segment;
}

/**
 * The storage path of a pending upload slot: `pending/<kind>/<HR id>/<upload id>/<file name>`, each
 * part one sanitized segment. The upload-url route mints exactly this and the submit route accepts
 * nothing else, so the shape is defined here, once.
 */
export function buildPendingVacationAttachmentPath(input: {
  fileName: string | null | undefined;
  hrId: string | null | undefined;
  kind: PendingVacationAttachmentKind;
  uploadId: string;
}) {
  return [
    pendingAttachmentRoot,
    input.kind,
    pendingSegment(input.hrId, unknownEmployeeSegment),
    input.uploadId,
    pendingSegment(input.fileName, input.kind === "sick" ? "sick-document" : "compensatory-event-photo"),
  ].join("/");
}

/** The parts of a pending upload slot, or null for any path that is not exactly one. */
export function parsePendingVacationAttachmentPath(storagePath: string | null | undefined) {
  const segments = String(storagePath ?? "").split("/");
  if (segments.length !== 5) return null;
  const [root, kind, owner, uploadId, fileName] = segments;
  if (root !== pendingAttachmentRoot || !isPendingVacationAttachmentKind(kind)) return null;
  if (!isPendingSegment(owner) || !pendingUploadIdPattern.test(uploadId) || !isPendingSegment(fileName)) return null;
  return { fileName, kind, owner, uploadId };
}

/**
 * True only for the caller's OWN pending upload slot of the expected kind. The submit route downloads
 * the referenced object into the new request and then deletes it with the service-role client, so an
 * unchecked path let any signed-in employee copy, and then erase, another employee's filed medical
 * document. Check it before any storage call.
 */
export function isOwnPendingVacationAttachmentPath(input: {
  hrId: string | null | undefined;
  kind: PendingVacationAttachmentKind;
  storagePath: string | null | undefined;
}) {
  const parsed = parsePendingVacationAttachmentPath(input.storagePath);
  return (
    parsed !== null &&
    parsed.kind === input.kind &&
    parsed.owner === pendingSegment(input.hrId, unknownEmployeeSegment)
  );
}

// Sick documents and compensatory-day event photos routinely exceed Vercel's ~4.5MB serverless
// request-body cap (a phone camera JPEG alone is often 5-9MB), so large files stream straight to a
// temporary object in the "leave-attachments" bucket via a short-lived signed upload URL
// (/api/vacations/attachments/upload-url) instead of riding through the /api/vacations/requests
// function body. The request then references the pending object by storage path. This resolver
// downloads that object into the same VacationAttachmentUpload shape the small-file multipart path
// already produces, so every existing validation/upload/audit code path in service.ts is unchanged.
export async function resolvePendingVacationAttachment(
  storagePath: string,
  meta: { contentType?: string | null; fileName?: string | null } = {},
): Promise<VacationAttachmentUpload> {
  // The route has already matched the path to the caller. This service-role read still refuses
  // anything that is not a pending upload slot, so it can never be pointed at a filed document.
  if (!parsePendingVacationAttachmentPath(storagePath)) {
    throw new Error("Uploaded file was not found in storage. Please re-upload.");
  }
  const { data, error } = await getSupabaseAdmin().storage.from(vacationAttachmentBucket).download(storagePath);
  if (error || !data) {
    throw new Error("Uploaded file was not found in storage. Please re-upload.");
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  // Prefer the original client-reported content type / name — the exact same source the direct
  // multipart path uses (browser File.type / File.name) — so the attachment validators behave
  // identically regardless of transport. Only fall back to the stored object's type and the storage
  // path basename if the client metadata is somehow absent, never silently downgrading a real image
  // to application/octet-stream (which the compensatory image-only validator would reject).
  const contentType = (meta.contentType && meta.contentType.trim()) || data.type || "application/octet-stream";
  const fileName = (meta.fileName && meta.fileName.trim()) || storagePath.split("/").pop() || "upload";
  return {
    bytes,
    contentType,
    fileName,
    size: bytes.length,
  };
}

/** Best-effort delete of a pending storage-path attachment (no-op for the small-file multipart path). */
export async function removePendingVacationAttachment(storagePath: string | null | undefined): Promise<void> {
  // A service-role delete: it only ever reaches a pending upload slot, whatever a caller hands it.
  if (!storagePath || !parsePendingVacationAttachmentPath(storagePath)) return;
  await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove([storagePath]).catch(() => undefined);
}
