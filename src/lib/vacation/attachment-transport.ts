import { getSupabaseAdmin } from "@/lib/supabase/server";
import { vacationAttachmentBucket, type VacationAttachmentUpload } from "@/lib/vacation/service";

// Sick documents and compensatory-day event photos routinely exceed Vercel's ~4.5MB serverless
// request-body cap (a phone camera JPEG alone is often 5-9MB), so large files stream straight to a
// temporary object in the "leave-attachments" bucket via a short-lived signed upload URL
// (/api/vacations/attachments/upload-url) instead of riding through the /api/vacations/requests
// function body. The request then references the pending object by storage path. This resolver
// downloads that object into the same VacationAttachmentUpload shape the small-file multipart path
// already produces, so every existing validation/upload/audit code path in service.ts is unchanged.
export async function resolvePendingVacationAttachment(storagePath: string): Promise<VacationAttachmentUpload> {
  const { data, error } = await getSupabaseAdmin().storage.from(vacationAttachmentBucket).download(storagePath);
  if (error || !data) {
    throw new Error("Uploaded file was not found in storage. Please re-upload.");
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const fileName = storagePath.split("/").pop() || "upload";
  return {
    bytes,
    contentType: data.type || "application/octet-stream",
    fileName,
    size: bytes.length,
  };
}

/** Best-effort delete of a pending storage-path attachment (no-op for the small-file multipart path). */
export async function removePendingVacationAttachment(storagePath: string | null | undefined): Promise<void> {
  if (!storagePath) return;
  await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove([storagePath]).catch(() => undefined);
}
