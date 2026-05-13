import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getSupabaseAdmin } from "@/lib/supabase/server";

type UploadMode = "local" | "supabase";

const allowedMimeTypes = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const allowedExtensions = new Set([".doc", ".docx", ".jpeg", ".jpg", ".pdf", ".png", ".webp"]);

function attachmentMode(): UploadMode {
  return process.env.LEAVE_ATTACHMENT_STORAGE_MODE === "supabase" ? "supabase" : "local";
}

function attachmentBucket() {
  return process.env.LEAVE_ATTACHMENTS_BUCKET || "leave-attachments";
}

function maxAttachmentBytes() {
  const configured = Number(process.env.LEAVE_ATTACHMENT_MAX_BYTES ?? 10 * 1024 * 1024);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 1024 * 1024;
}

function cleanFileName(name: string) {
  const parsed = path.parse(name);
  const base = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  return `${base}${parsed.ext.toLowerCase()}`;
}

function cleanEmployeeFolder(employeeHrId: string) {
  return employeeHrId.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "_") || "UNKNOWN";
}

export function createLeaveAttachmentObjectPath(employeeHrId: string, fileName: string, now = new Date()) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${cleanEmployeeFolder(employeeHrId)}/${year}/${month}/${randomUUID()}-${cleanFileName(fileName)}`;
}

function storageReference(bucket: string, storagePath: string) {
  return `supabase://${bucket}/${storagePath}`;
}

function parseStorageReference(reference: string | null | undefined) {
  if (!reference?.startsWith("supabase://")) return null;
  const [bucket, ...pathParts] = reference.replace("supabase://", "").split("/");
  const objectPath = pathParts.join("/");
  if (!bucket || !objectPath) return null;
  return { bucket, path: objectPath };
}

function localUploadRoot() {
  return path.resolve(process.cwd(), "public", "uploads", "leave");
}

export function isRenderableLeaveAttachmentReference(reference: string | null | undefined) {
  if (!reference) return false;
  return reference.startsWith("/uploads/leave/");
}

export function validateLeaveAttachment(file: Pick<File, "name" | "size" | "type"> | null | undefined) {
  if (!file) return { ok: true as const };
  const extension = path.extname(file.name).toLowerCase();
  if (file.size > maxAttachmentBytes()) {
    return { error: `Attachment is larger than ${Math.round(maxAttachmentBytes() / 1024 / 1024)}MB.`, ok: false as const };
  }
  if (!allowedExtensions.has(extension)) return { error: "Attachment file type is not allowed.", ok: false as const };
  if (file.type && !allowedMimeTypes.has(file.type)) return { error: "Attachment content type is not allowed.", ok: false as const };
  return { ok: true as const };
}

export async function uploadLeaveAttachment(file: File | null | undefined, employeeHrId: string): Promise<string | null> {
  if (!file || file.size === 0) return null;
  const validation = validateLeaveAttachment(file);
  if (!validation.ok) throw new Error(validation.error);

  const cleanName = `${Date.now()}-${randomUUID()}-${cleanFileName(file.name)}`;

  if (attachmentMode() === "supabase") {
    const bucket = attachmentBucket();
    const objectPath = createLeaveAttachmentObjectPath(employeeHrId, file.name);
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(bucket).upload(objectPath, Buffer.from(await file.arrayBuffer()), {
      cacheControl: "3600",
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (error) throw error;
    return storageReference(bucket, objectPath);
  }

  const directory = localUploadRoot();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, cleanName), Buffer.from(await file.arrayBuffer()));
  return `/uploads/leave/${cleanName}`;
}

export async function getLeaveAttachmentUrl(reference: string | null | undefined): Promise<string | null> {
  if (!reference) return null;
  const parsed = parseStorageReference(reference);
  if (!parsed) return isRenderableLeaveAttachmentReference(reference) ? reference : null;
  const expiresIn = Number(process.env.LEAVE_ATTACHMENT_SIGNED_URL_SECONDS ?? 900);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(parsed.bucket)
    .createSignedUrl(parsed.path, Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900);
  if (error) throw error;
  return data.signedUrl;
}

export function parseLeaveAttachmentStorageReference(reference: string | null | undefined) {
  return parseStorageReference(reference);
}

export async function deleteLeaveAttachment(reference: string | null | undefined) {
  if (!reference) return { deleted: false };
  const parsed = parseStorageReference(reference);
  if (parsed) {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.path]);
    if (error) throw error;
    return { deleted: true };
  }
  if (!reference.startsWith("/uploads/leave/")) return { deleted: false };
  const uploadRoot = localUploadRoot();
  const localPath = path.resolve(uploadRoot, reference.replace(/^\/uploads\/leave\/+/, ""));
  if (!localPath.startsWith(`${uploadRoot}${path.sep}`)) return { deleted: false };
  await unlink(localPath).catch(() => undefined);
  return { deleted: true };
}
