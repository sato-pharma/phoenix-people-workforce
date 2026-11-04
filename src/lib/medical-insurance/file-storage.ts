import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { PRIVATE_FILE_CACHE_CONTROL_SECONDS } from "@/lib/uploads/private-file-cache";

/**
 * Storage for invoices, communication tools, forms, the policy and emails.
 *
 * The bucket is PRIVATE and stays private: an invoice names every employee with their date of birth. Every
 * read goes through a file route that resolves the path server-side from a row id, so no caller ever names
 * a storage object, and no signed link is ever handed to a browser.
 */
export const MEDICAL_INSURANCE_BUCKET = "medical-insurance";

/** Matches `file_size_limit` on the bucket. Both exist so the failure is a message, not a 500. */
export const MEDICAL_INSURANCE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  msg: "application/vnd.ms-outlook",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/**
 * The type a file is stored as, from its extension. A browser leaves `type` empty for an Outlook message
 * and names a ZIP differently on Windows than anywhere else, so what it sent is not what decides. Null when
 * the extension is not one the bucket takes.
 */
export function medicalInsuranceContentType(fileName: string): string | null {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
}

export function assertMedicalInsuranceFileAllowed(input: { fileName: string; size: number }): string {
  if (input.size <= 0) throw new Error("That file is empty. Choose the file again.");
  if (input.size > MEDICAL_INSURANCE_MAX_UPLOAD_BYTES) throw new Error("That file is larger than 25 MB. Split it into two files.");
  const contentType = medicalInsuranceContentType(input.fileName);
  if (!contentType) throw new Error("This must be a PDF, Word, Excel, PowerPoint, picture, ZIP or email (.eml, .msg) file.");
  return contentType;
}

function sanitizeSegment(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function buildMedicalInsuranceFilePath(input: { folder: string; fileName: string; uniqueSuffix?: string }) {
  return `${sanitizeSegment(input.folder, "file")}/${sanitizeSegment(input.uniqueSuffix ?? randomUUID(), "file")}-${sanitizeSegment(input.fileName, "document")}`;
}

export async function uploadMedicalInsuranceFile(input: { bytes: Buffer; contentType: string; path: string }) {
  const { error } = await getSupabaseAdmin()
    .storage.from(MEDICAL_INSURANCE_BUCKET)
    .upload(input.path, input.bytes, {
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
      contentType: input.contentType,
      upsert: false,
    });
  if (error) throw new Error(`Unable to store the file: ${error.message}`);
}

export async function removeMedicalInsuranceFile(path: string) {
  await getSupabaseAdmin().storage.from(MEDICAL_INSURANCE_BUCKET).remove([path]);
}

export async function downloadMedicalInsuranceFile(path: string): Promise<Buffer> {
  const { data, error } = await getSupabaseAdmin().storage.from(MEDICAL_INSURANCE_BUCKET).download(path);
  if (error || !data) throw new Error(`Unable to read the stored file: ${error?.message ?? "file not found"}`);
  return Buffer.from(await data.arrayBuffer());
}
