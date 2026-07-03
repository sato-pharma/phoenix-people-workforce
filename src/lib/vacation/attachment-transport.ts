import { getSupabaseAdmin } from "@/lib/supabase/server";
import { vacationAttachmentBucket, type VacationAttachmentUpload } from "@/lib/vacation/service";

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
  if (!storagePath) return;
  await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove([storagePath]).catch(() => undefined);
}
