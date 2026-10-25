import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { PRIVATE_FILE_CACHE_CONTROL_SECONDS } from "@/lib/uploads/private-file-cache";

/**
 * Storage for the scans behind the hiring checklist.
 *
 * The bucket is PRIVATE and must stay private — these are birth certificates, national IDs,
 * criminal records and military-status papers for real employees. Nothing in here is ever served
 * from a public URL. Every read goes through the file route, which resolves the storage path
 * server-side from a row id, so no caller ever names a storage object.
 */
export const HIRING_DOCUMENTS_BUCKET = "hiring-documents";

/** Matches `file_size_limit` on the bucket. Both exist so the failure is a message, not a 500. */
export const HIRING_DOCUMENT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Matches `allowed_mime_types` on the bucket, for the same reason. */
export const HIRING_DOCUMENT_ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const HIRING_DOCUMENT_SIGNED_URL_TTL_SECONDS = 60 * 5;

function sanitizeStorageSegment(value: string | null | undefined, fallback: string) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

/**
 * Where one file lives: `<employee>/<document>/<random>-<name>`.
 *
 * The random segment is not decoration. A national ID is routinely photographed twice — front and
 * back — and both arrive as `IMG_0042.jpg` from the same phone. Keying on the file name alone would
 * make the second upload either overwrite the first or fail, and the first is the one that would be
 * lost. It also makes `storage_path` genuinely unique, which is what lets the table enforce that
 * one object belongs to exactly one row.
 *
 * The employee and document segments are for humans reading the bucket in the Supabase console
 * during an incident; nothing in the application resolves a path by building one from user input.
 */
export function buildHiringDocumentFilePath(input: {
  documentId: string;
  employeeHrId: string;
  fileName: string;
  /** Injectable so a test can assert the whole path rather than a prefix. */
  uniqueSuffix?: string;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const documentId = sanitizeStorageSegment(input.documentId, "unknown-document");
  const unique = sanitizeStorageSegment(input.uniqueSuffix ?? randomUUID(), "file");
  const fileName = sanitizeStorageSegment(input.fileName, "document");

  return `${employeeHrId}/${documentId}/${unique}-${fileName}`;
}

/**
 * Reject a file before it reaches storage, with a message HR can act on.
 *
 * Supabase enforces both of these at the bucket too. This check exists because the bucket's refusal
 * arrives as a storage error string that ends up in front of a user as something like
 * `mime type application/vnd.ms-excel is not supported` — accurate, and useless to the person
 * holding the certificate.
 */
export function assertHiringDocumentFileAllowed(input: { contentType: string; size: number }) {
  if (input.size <= 0) {
    throw new Error("That file is empty. Choose the file again.");
  }

  if (input.size > HIRING_DOCUMENT_MAX_UPLOAD_BYTES) {
    throw new Error("That file is larger than 15 MB. Scan it at a lower resolution, or split it into two files.");
  }

  if (!HIRING_DOCUMENT_ALLOWED_CONTENT_TYPES.has(input.contentType.trim().toLowerCase())) {
    throw new Error("Hiring documents must be a PDF, JPG, PNG or WEBP file.");
  }
}

export async function uploadHiringDocumentFile(input: {
  bytes: Buffer;
  contentType: string;
  path: string;
}) {
  const { error } = await getSupabaseAdmin()
    .storage.from(HIRING_DOCUMENTS_BUCKET)
    .upload(input.path, input.bytes, {
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
      contentType: input.contentType,
      // False, always. Every path carries its own random segment, so a collision here means two
      // uploads raced for one object — which must fail loudly rather than quietly replace a
      // certificate somebody already filed.
      upsert: false,
    });

  if (error) {
    throw new Error(`Unable to store the document: ${error.message}`);
  }

  return input.path;
}

/**
 * Remove objects, tolerating the ones that are already gone.
 *
 * Called on the rollback path when a database insert fails after an upload succeeded, and when HR
 * deletes a file. Neither caller can do anything useful with a storage error, and both have already
 * decided the object should not exist.
 */
export async function removeHiringDocumentFiles(paths: string[]) {
  const wanted = paths.filter(Boolean);
  if (wanted.length === 0) return;

  await getSupabaseAdmin().storage.from(HIRING_DOCUMENTS_BUCKET).remove(wanted);
}

/**
 * Download a stored file's bytes for the server to stream on.
 *
 * A signed URL is deliberately NOT what the read path uses. Handing the browser a signed URL puts
 * a working, shareable link to a birth certificate in the address bar and in browser history, and
 * it stays live for its whole TTL after the user has closed the page. Streaming through the route
 * keeps every read behind `assertPermission`.
 */
export async function downloadHiringDocumentFile(path: string): Promise<Buffer> {
  const { data, error } = await getSupabaseAdmin().storage.from(HIRING_DOCUMENTS_BUCKET).download(path);

  if (error || !data) {
    throw new Error(`Unable to read the stored document: ${error?.message ?? "file not found"}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

/**
 * A short-lived signed URL, for the one case streaming cannot serve: an inline PDF viewer that
 * needs byte-range requests. Five minutes, because a link to a personnel document should expire
 * before the person who opened it has finished reading the page it was on.
 */
export async function createHiringDocumentSignedUrl(path: string) {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(HIRING_DOCUMENTS_BUCKET)
    .createSignedUrl(path, HIRING_DOCUMENT_SIGNED_URL_TTL_SECONDS);

  if (error) return null;
  return data.signedUrl;
}
