import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { removePendingVacationAttachment, resolvePendingVacationAttachment } from "@/lib/vacation/attachment-transport";
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
    const sickDocument = body instanceof FormData ? body.get("sickDocument") : null;
    const compensatoryPhoto = body instanceof FormData ? body.get("compensatoryPhoto") : null;
    const oversizedSick = isFormFile(sickDocument) ? rejectOversizedVacationFile(sickDocument) : null;
    if (oversizedSick) return oversizedSick;
    const oversizedCompensatory = isFormFile(compensatoryPhoto) ? rejectOversizedVacationFile(compensatoryPhoto) : null;
    if (oversizedCompensatory) return oversizedCompensatory;

    let sickAttachment: VacationAttachmentUpload | null = isFormFile(sickDocument)
      ? {
          bytes: Buffer.from(await sickDocument.arrayBuffer()),
          contentType: sickDocument.type || "application/octet-stream",
          fileName: sickDocument.name || "sick-document",
          size: sickDocument.size,
        }
      : null;
    let compensatoryAttachment: VacationAttachmentUpload | null = isFormFile(compensatoryPhoto)
      ? {
          bytes: Buffer.from(await compensatoryPhoto.arrayBuffer()),
          contentType: compensatoryPhoto.type || "application/octet-stream",
          fileName: compensatoryPhoto.name || "compensatory-event-photo",
          size: compensatoryPhoto.size,
        }
      : null;
    if (body instanceof FormData) {
      const sickAttachmentStoragePath = formText(body, "sickAttachmentStoragePath");
      if (!sickAttachment && sickAttachmentStoragePath) {
        pendingAttachmentPaths.push(sickAttachmentStoragePath);
        sickAttachment = await resolvePendingVacationAttachment(sickAttachmentStoragePath);
      }
      const compensatoryAttachmentStoragePath = formText(body, "compensatoryAttachmentStoragePath");
      if (!compensatoryAttachment && compensatoryAttachmentStoragePath) {
        pendingAttachmentPaths.push(compensatoryAttachmentStoragePath);
        compensatoryAttachment = await resolvePendingVacationAttachment(compensatoryAttachmentStoragePath);
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
      { baseUrl: new URL(request.url).origin },
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
