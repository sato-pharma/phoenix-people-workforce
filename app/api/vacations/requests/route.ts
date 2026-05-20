import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createVacationRequest,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

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
  try {
    const access = await resolveAccessContext(request);
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.includes("multipart/form-data")
      ? await request.formData()
      : await request.json();
    const sickDocument = body instanceof FormData ? body.get("sickDocument") : null;
    const result = await createVacationRequest(
      access,
      body instanceof FormData
        ? {
            dayPart: formText(body, "dayPart"),
            endDate: formText(body, "endDate"),
            sickAttachment: isFormFile(sickDocument)
              ? {
                  bytes: Buffer.from(await sickDocument.arrayBuffer()),
                  contentType: sickDocument.type || "application/octet-stream",
                  fileName: sickDocument.name || "sick-document",
                  size: sickDocument.size,
                }
              : null,
            startDate: formText(body, "startDate"),
            vacationType: formText(body, "vacationType"),
          }
        : {
            dayPart: body.dayPart,
            endDate: body.endDate,
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
    return NextResponse.json({ error: "vacation_request_failed", message, success: false }, { status: 400 });
  }
}
