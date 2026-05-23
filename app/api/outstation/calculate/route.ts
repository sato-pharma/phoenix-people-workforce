import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { calculateOutstationExpense } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseCarEvidenceMetadata } from "@/app/api/outstation/request-body";
import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = (await request.json()) as Record<string, unknown>;
    const tripStartDate = String(body.tripStartDate ?? "");
    const tripEndDate = String(body.tripEndDate ?? "");
    const parsedTripStartDate = Date.parse(tripStartDate);
    const parsedTripEndDate = Date.parse(tripEndDate);

    if (
      Number.isFinite(parsedTripStartDate) &&
      Number.isFinite(parsedTripEndDate) &&
      parsedTripEndDate < parsedTripStartDate
    ) {
      return NextResponse.json(
        { error: "invalid_date_range", message: "End date cannot be before start date" },
        { status: 400 },
      );
    }

    const result = await calculateOutstationExpense(access, {
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
      tripEndDate,
      tripStartDate,
      attachmentCount: Number(body.attachmentCount ?? 0),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to calculate outstation expense.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_calculation_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
