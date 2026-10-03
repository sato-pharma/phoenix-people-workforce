import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  isOwnPendingVacationAttachmentPath,
  removePendingVacationAttachment,
  resolvePendingVacationAttachment,
} from "@/lib/vacation/attachment-transport";
import {
  createVacationRequest,
  isVacationSchemaMissing,
  vacationErrorMessage,
  type VacationAttachmentUpload,
} from "@/lib/vacation/service";
import {
  assertVacationRouteRateLimit,
  rejectOversizedVacationFile,
  rejectOversizedVacationUploadRequest,
} from "@/lib/vacation/route-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function isFormFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value &&
    Number((value as { size?: unknown }).size) > 0
  );
}

export async function POST(request: Request) {
  // Large sick/compensatory files bypass this function's body entirely — the browser already streamed
  // them straight to Storage (see /api/vacations/attachments/upload-url) and references them here by
  // path instead of sending the bytes. Track any such paths so the pending object is always cleaned up.
  const pendingAttachmentPaths: string[] = [];
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const uploadSizeError = rejectOversizedVacationUploadRequest(request);
    if (uploadSizeError) return uploadSizeError;

    const access = await resolveAccessContext(request);
    // Asserted again inside createVacationRequest, but a referenced upload is downloaded and deleted
    // before that call, so a caller who may not file leave must be turned away before any storage call.
    await assertPermission(access, "leave", "create");
    await assertVacationRouteRateLimit({
      actor: access.loginId ?? access.hrId,
      limit: 12,
      request,
      scope: "vacation:upload",
      windowMs: 60_000,
    });
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.includes("multipart/form-data")
      ? await request.formData()
      : await request.json();
    // A sick request may carry SEVERAL documents (owner, 2026-10-03). They arrive as repeated
    // `sickDocument` parts, in the order the employee picked them; the FIRST stays in the legacy
    // single-attachment columns and the rest ride beside it into the attachments table.
    const sickDocuments = body instanceof FormData ? body.getAll("sickDocument").filter(isFormFile) : [];
    const sickDocument = sickDocuments[0] ?? null;
    const compensatoryPhoto = body instanceof FormData ? body.get("compensatoryPhoto") : null;
    for (const file of sickDocuments) {
      const oversized = rejectOversizedVacationFile(file);
      if (oversized) return oversized;
    }
    const oversizedCompensatory = isFormFile(compensatoryPhoto) ? rejectOversizedVacationFile(compensatoryPhoto) : null;
    if (oversizedCompensatory) return oversizedCompensatory;

    let sickAttachment: VacationAttachmentUpload | null = sickDocument
      ? {
          bytes: Buffer.from(await sickDocument.arrayBuffer()),
          contentType: sickDocument.type || "application/octet-stream",
          fileName: sickDocument.name || "sick-document",
          size: sickDocument.size,
        }
      : null;
    const sickAttachmentsExtra: VacationAttachmentUpload[] = [];
    for (const file of sickDocuments.slice(1)) {
      sickAttachmentsExtra.push({
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream",
        fileName: file.name || "sick-document",
        size: file.size,
      });
    }
    let compensatoryAttachment: VacationAttachmentUpload | null = isFormFile(compensatoryPhoto)
      ? {
          bytes: Buffer.from(await compensatoryPhoto.arrayBuffer()),
          contentType: compensatoryPhoto.type || "application/octet-stream",
          fileName: compensatoryPhoto.name || "compensatory-event-photo",
          size: compensatoryPhoto.size,
        }
      : null;
    if (body instanceof FormData) {
      // A storage path may only name the caller's OWN pending upload of the matching kind, exactly as
      // /api/vacations/attachments/upload-url minted it. Both are checked before any is collected or
      // downloaded: the service-role client copies the object into this request and the finally block
      // deletes it, so an unchecked path let anyone lift, then erase, another employee's filed document.
      // Repeated for a multi-document sick request, with `sickAttachmentContentType` and
      // `sickAttachmentFileName` repeated index-for-index beside it. The browser uses ONE transport
      // for the whole set — direct parts, or paths — so the order the employee picked is preserved
      // either way and the first file is always the first file.
      const sickAttachmentStoragePaths: string[] = sickAttachment
        ? []
        : body.getAll("sickAttachmentStoragePath").map((value) => String(value ?? "").trim()).filter(Boolean);
      const sickAttachmentContentTypes = body.getAll("sickAttachmentContentType").map((value) => String(value ?? "").trim());
      const sickAttachmentFileNames = body.getAll("sickAttachmentFileName").map((value) => String(value ?? "").trim());
      const compensatoryAttachmentStoragePath = compensatoryAttachment
        ? ""
        : formText(body, "compensatoryAttachmentStoragePath");
      if (
        sickAttachmentStoragePaths.some(
          (path) => !isOwnPendingVacationAttachmentPath({ hrId: access.hrId, kind: "sick", storagePath: path }),
        ) ||
        (compensatoryAttachmentStoragePath &&
          !isOwnPendingVacationAttachmentPath({
            hrId: access.hrId,
            kind: "compensatory",
            storagePath: compensatoryAttachmentStoragePath,
          }))
      ) {
        return NextResponse.json(
          {
            error: "invalid_attachment_path",
            message: "The attached file does not match your upload. Please attach the file again and resubmit.",
            success: false,
          },
          { status: 400 },
        );
      }
      for (const [index, path] of sickAttachmentStoragePaths.entries()) {
        pendingAttachmentPaths.push(path);
        const resolved = await resolvePendingVacationAttachment(path, {
          contentType: sickAttachmentContentTypes[index] ?? "",
          fileName: sickAttachmentFileNames[index] ?? "",
        });
        if (index === 0) sickAttachment = resolved;
        else sickAttachmentsExtra.push(resolved);
      }
      if (compensatoryAttachmentStoragePath) {
        pendingAttachmentPaths.push(compensatoryAttachmentStoragePath);
        compensatoryAttachment = await resolvePendingVacationAttachment(compensatoryAttachmentStoragePath, {
          contentType: formText(body, "compensatoryAttachmentContentType"),
          fileName: formText(body, "compensatoryAttachmentFileName"),
        });
      }
    }

    const result = await createVacationRequest(
      access,
      body instanceof FormData
        ? {
            compensatoryAttachment,
            compensatoryEventDate: formText(body, "compensatoryEventDate"),
            compensatoryEventLocation: formText(body, "compensatoryEventLocation"),
            compensatoryEventName: formText(body, "compensatoryEventName"),
            compensatoryManager1: formText(body, "compensatoryManager1"),
            compensatoryManager2: formText(body, "compensatoryManager2"),
            dayPart: formText(body, "dayPart"),
            employeeNote: formText(body, "employeeNote"),
            endDate: formText(body, "endDate"),
            otherReason: formText(body, "otherReason"),
            sickAttachment,
            sickAttachmentsExtra,
            startDate: formText(body, "startDate"),
            vacationType: formText(body, "vacationType"),
          }
        : {
            compensatoryEventDate: body.compensatoryEventDate,
            compensatoryEventLocation: body.compensatoryEventLocation,
            compensatoryEventName: body.compensatoryEventName,
            compensatoryManager1: body.compensatoryManager1,
            compensatoryManager2: body.compensatoryManager2,
            dayPart: body.dayPart,
            employeeNote: body.employeeNote,
            endDate: body.endDate,
            otherReason: body.otherReason,
            startDate: body.startDate,
            vacationType: body.vacationType,
          },
    );

    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to submit vacation request.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json({ error: "vacation_request_failed", message, success: false }, { status: 400 });
  } finally {
    await Promise.all(pendingAttachmentPaths.map((path) => removePendingVacationAttachment(path)));
  }
}
