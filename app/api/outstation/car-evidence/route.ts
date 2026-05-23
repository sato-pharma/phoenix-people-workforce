import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getOutstationEmployeeContext } from "@/lib/outstation/service";
import { uploadOutstationCarEvidenceFile } from "@/lib/outstation/car-evidence-storage";
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

    const carEvidenceImage = formData.get("carEvidenceImage");
    const capturedAt = formText(formData, "capturedAt");
    const capturedLatitude = Number(formText(formData, "capturedLatitude"));
    const capturedLongitude = Number(formText(formData, "capturedLongitude"));
    const capturedLocationLabel = formText(formData, "capturedLocationLabel");
    const requestDraftId = formText(formData, "requestDraftId");

    if (!carEvidenceImage || !formFile(carEvidenceImage)) {
      return NextResponse.json(
        { error: "car_evidence_upload_failed", message: "No car evidence image was provided." },
        { status: 400 },
      );
    }

    if (!capturedAt || !capturedLocationLabel || !Number.isFinite(capturedLatitude) || !Number.isFinite(capturedLongitude)) {
      return NextResponse.json(
        { error: "car_evidence_upload_failed", message: "Captured car evidence metadata is incomplete." },
        { status: 400 },
      );
    }

    const imagePath = await uploadOutstationCarEvidenceFile({
      imageFile: carEvidenceImage,
      metadata: {
        capturedAt,
        capturedLatitude,
        capturedLocationLabel,
        capturedLongitude,
        employeeHrId: context.employeeHrId,
        requestDraftId: requestDraftId || null,
        requestId: null,
        source: "live_camera",
      },
    });

    return NextResponse.json({ carEvidenceImagePath: imagePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload car evidence image.";
    const status = uploadStatus(error);
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "car_evidence_upload_failed",
        message,
      },
      { status },
    );
  }
}
