import { NextResponse } from "next/server";

import { sendPreparedOffer } from "@/lib/recruitment/applications";
import type { SendPhoenixEmailAttachment } from "@/lib/email/send-phoenix-email";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MANUAL_ATTACHMENTS = 6;
const MAX_SINGLE_FILE_BYTES = 15 * 1024 * 1024; // 15 MB per file
const MAX_TOTAL_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB total — under Cloud Run memory + Resend budget

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

// Thrown to reject an upload with a specific HTTP status (413 too-large / 400 too-many).
class UploadRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Optional manual HR attachments arrive as multipart form-data under the "attachments" field.
// A plain (bodyless) JSON call still works — it just sends with the auto-generated PDF only.
async function parseManualAttachments(request: Request): Promise<SendPhoenixEmailAttachment[]> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) return [];

  // Reject oversized uploads BEFORE request.formData() materializes the whole body in memory,
  // so a large payload can't OOM/timeout the 1 GiB offer-send request instead of being rejected.
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_TOTAL_UPLOAD_BYTES) {
    throw new UploadRejected(`Attachments exceed the ${mb(MAX_TOTAL_UPLOAD_BYTES)} MB total limit.`, 413);
  }

  const form = await request.formData();
  const files = form.getAll("attachments").filter((entry): entry is File => entry instanceof File);

  // Never silently truncate — a candidate must not miss required attachments after the Nth file
  // while HR is told the send succeeded. Reject the whole request instead.
  if (files.length > MAX_MANUAL_ATTACHMENTS) {
    throw new UploadRejected(`You can attach at most ${MAX_MANUAL_ATTACHMENTS} files.`, 400);
  }

  let total = 0;
  const attachments: SendPhoenixEmailAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_SINGLE_FILE_BYTES) {
      throw new UploadRejected(
        `"${file.name || "attachment"}" exceeds the ${mb(MAX_SINGLE_FILE_BYTES)} MB per-file limit.`,
        413,
      );
    }
    total += file.size;
    if (total > MAX_TOTAL_UPLOAD_BYTES) {
      throw new UploadRejected(`Attachments exceed the ${mb(MAX_TOTAL_UPLOAD_BYTES)} MB total limit.`, 413);
    }
    if (file.size === 0) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    attachments.push({
      filename: file.name || "attachment",
      content: bytes.toString("base64"),
      contentType: file.type || "application/octet-stream",
    });
  }
  return attachments;
}

// Offer pipeline step 5 — send the generated offer to the candidate.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const attachments = await parseManualAttachments(request);
    const result = await sendPreparedOffer(id, access, attachments);
    return NextResponse.json({ success: true, application: result.application, offerId: result.offerId });
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return recruitmentApiError(error, "Failed to send the prepared offer.");
  }
}
