import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { calculateOutstationExpense } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseCarEvidenceMetadata } from "@/app/api/outstation/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { parseOutstationTypeFields } from "@/lib/outstation/request-fields";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = (await request.json()) as Record<string, unknown>;
    const outstationTypes = parseOutstationTypeFields(body, {
      onMissing: "default",
    });
    if (!outstationTypes.ok) {
      return NextResponse.json(
        { error: outstationTypes.error, message: outstationTypes.message },
        { status: 400 },
      );
    }

    const result = await calculateOutstationExpense(access, {
      capturedAccuracyMeters: Number(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: Number(body.capturedLatitude),
      capturedLongitude: Number(body.capturedLongitude),
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      expenseType: outstationTypes.expenseType,
      goTicketAmount: Number(body.goTicketAmount ?? 0),
      hasTicketAttachments: Boolean(body.hasTicketAttachments),
      amWorkload: optionalNumber(body.amWorkload),
      hrNotes: optionalText(body.hrNotes),
      hrStatus: optionalText(body.hrStatus),
      kilometerReading:
        body.kilometerReading == null ? undefined : Number(body.kilometerReading),
      medicalTripHrId:
        typeof body.medicalTripHrId === "string" ? body.medicalTripHrId : undefined,
      medicalTripName:
        typeof body.medicalTripName === "string" ? body.medicalTripName : undefined,
      meetingAmount: optionalNumber(body.meetingAmount),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      offlineCaptured: Boolean(body.offlineCaptured),
      otherAmount: optionalNumber(body.otherAmount),
      pmWorkload: optionalNumber(body.pmWorkload),
      returnTicketAmount: Number(body.returnTicketAmount ?? 0),
      carEvidenceMetadata: parseCarEvidenceMetadata(body),
      transportationType: outstationTypes.transportationType,
      travelCostAmount: optionalNumber(body.travelCostAmount),
      tripType: optionalText(body.tripType),
      tripEndDate: String(body.tripEndDate ?? ""),
      tripStartDate: String(body.tripStartDate ?? ""),
      attachmentCount: Number(body.attachmentCount ?? 0),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to calculate outstation expense.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_calculation_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
