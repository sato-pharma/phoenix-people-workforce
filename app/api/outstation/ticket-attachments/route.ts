import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getOutstationEmployeeContext } from "@/lib/outstation/service";
import { uploadOutstationTicketAttachments } from "@/lib/outstation/car-evidence-storage";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    Number(value.size) > 0
  );
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function uploadStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("missing") ||
    message.includes("too large") ||
    message.includes("must be")
  ) {
    return 400;
  }

  return 500;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const formData = await request.formData();
    const context = await getOutstationEmployeeContext(access);
    const requestDraftId = formText(formData, "requestDraftId") || randomUUID();
    const attachmentFiles = [
      ...formData.getAll("ticketFiles"),
      ...formData.getAll("ticketAttachments"),
    ].filter(formFile);

    const attachments = await Promise.all(
      attachmentFiles.map(async (file) => ({
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream",
        fileName: file.name || "ticket-attachment",
        size: file.size,
      })),
    );

    if (attachments.length === 0) {
      return NextResponse.json(
        { error: "ticket_attachment_upload_failed", message: "No ticket files were provided." },
        { status: 400 },
      );
    }

    const uploadedAttachments = await uploadOutstationTicketAttachments(
      attachments.map((attachment) => ({
        ...attachment,
        employeeHrId: context.employeeHrId,
        requestDraftId,
      })),
    );

    return NextResponse.json({
      ticketAttachmentMetadata: uploadedAttachments,
      ticketAttachmentPaths: uploadedAttachments.map((attachment) => attachment.path),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload ticket attachments.";
    const status = uploadStatus(error);
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "ticket_attachment_upload_failed",
        message,
      },
      { status },
    );
  }
}
