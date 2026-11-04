import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { CvParseIsolationUnavailableError, CvParseLimitError } from "@/lib/recruitment/cv-text-isolation";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

import { isMedicalInsuranceInputError, isMedicalInsuranceSchemaMissing, medicalInsuranceErrorMessage } from "./service";

const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** One answer for every route here: a refusal the person can act on keeps its own words. */
export function medicalInsuranceErrorResponse(error: unknown, code: string) {
  if (isApiRateLimitError(error)) {
    return NextResponse.json({ error: "rate_limited", message: error.message }, { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden", message: "Medical insurance is limited to the seats that manage it." }, { status: 403 });
  }
  if (isMedicalInsuranceInputError(error)) {
    return NextResponse.json({ error: code, message: medicalInsuranceErrorMessage(error) }, { status: 400 });
  }
  if (error instanceof CvParseLimitError || error instanceof CvParseIsolationUnavailableError) {
    return NextResponse.json({ error: code, message: "This PDF could not be read. Nothing was saved. Try the insurer's original file." }, { status: 400 });
  }
  if (isMedicalInsuranceSchemaMissing(error)) {
    return NextResponse.json({ error: "medical_insurance_schema_missing", message: "Medical insurance is not ready yet: its database tables have not been applied." }, { status: 409 });
  }
  return NextResponse.json({ error: code, message: medicalInsuranceErrorMessage(error) }, { status: 500 });
}

export function medicalInsuranceWorkbookResponse(buffer: ArrayBuffer, fileName: string) {
  return new NextResponse(buffer, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
      "content-type": XLSX_MEDIA_TYPE,
    },
    status: 200,
  });
}

/** A stored file, streamed through the route so every read stays behind the permission check. */
export function medicalInsuranceFileResponse(file: { bytes: Buffer; contentType: string; fileName: string }, wantsDownload: boolean) {
  const safeName = file.fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "file";
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `${wantsDownload ? "attachment" : "inline"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "content-length": String(file.bytes.length),
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });
}

/** A JSON body, or an empty object when there is none. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
