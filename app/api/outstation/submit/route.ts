import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { submitOutstationRequest } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceMetadata,
} from "@/app/api/outstation/request-body";
import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function outstationSubmitStatus(error: unknown) {
  if (isForbiddenError(error)) {
    return 403;
  }
  if (isWorkflowRegistryTransitionError(error)) {
    return 409;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("missing") ||
    message.includes("not linked") ||
    message.includes("not available") ||
    message.includes("not eligible") ||
    message.includes("requires")
  ) {
    return 400;
  }

  return 500;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = (await request.json()) as Record<string, unknown>;
    const result = await submitOutstationRequest(access, {
      capturedAccuracyMeters: Number(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: Number(body.capturedLatitude),
      capturedLongitude: Number(body.capturedLongitude),
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      expenseType: String(body.expenseType ?? "traveling") as OutstationExpenseType,
      goTicketAmount: Number(body.goTicketAmount ?? 0),
      hasTicketAttachments: Boolean(body.hasTicketAttachments),
      kilometerReading:
        body.kilometerReading == null ? undefined : Number(body.kilometerReading),
      medicalTripHrId:
        typeof body.medicalTripHrId === "string" ? body.medicalTripHrId : undefined,
      medicalTripName:
        typeof body.medicalTripName === "string" ? body.medicalTripName : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      offlineCaptured: Boolean(body.offlineCaptured),
      returnTicketAmount: Number(body.returnTicketAmount ?? 0),
      carEvidenceMetadata: parseCarEvidenceMetadata(body),
      transportationType: String(body.transportationType ?? "car") as OutstationTransportationType,
      tripEndDate: String(body.tripEndDate ?? ""),
      tripStartDate: String(body.tripStartDate ?? ""),
      attachmentCount: Number(body.attachmentCount ?? 0),
      carEvidenceImageDataUrl: parseCarEvidenceImageDataUrl(body),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit outstation request.";
    const status = outstationSubmitStatus(error);
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_submit_failed", message },
      { status },
    );
  }
}
