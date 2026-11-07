import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { previewManagerExpenseCalculation } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { OutstationExpenseType, OutstationTransportationType } from "@/lib/outstation/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const body = (await request.json().catch(() => ({}))) as {
      claimedTotalAmount?: number;
      destinationArea?: string | null;
      destinationCity?: string | null;
      destinationCountry?: string | null;
      destinationLabel?: string | null;
      distanceKm?: number;
      employeeHrId?: string;
      expenseType?: OutstationExpenseType;
      meetingAmount?: number;
      otherAmount?: number;
      transportationType?: OutstationTransportationType;
      travelCostAmount?: number | null;
      tripEndDate?: string;
      tripStartDate?: string;
    };

    const employeeHrId =
      typeof body.employeeHrId === "string" ? body.employeeHrId.trim() : "";
    const rawDistanceKm = Number(body.distanceKm);
    const distanceKm = Number.isFinite(rawDistanceKm) ? rawDistanceKm : 0;
    const tripStartDate =
      typeof body.tripStartDate === "string" ? body.tripStartDate.trim() : "";
    const tripEndDate =
      typeof body.tripEndDate === "string" ? body.tripEndDate.trim() : "";
    const transportationType = body.transportationType;
    const expenseType: OutstationExpenseType =
      body.expenseType === "meeting" || body.expenseType === "other"
        ? body.expenseType
        : "traveling";
    // A Meeting entry never prices travel, so distance is the one input it does not need —
    // the modal stops asking for it once Meeting is selected.
    const requiresDistance = expenseType !== "meeting";

    if (
      !employeeHrId ||
      (requiresDistance && (!Number.isFinite(distanceKm) || distanceKm <= 0)) ||
      !tripStartDate ||
      !tripEndDate ||
      !transportationType ||
      !["car", "train", "bus", "other", "no_ticket"].includes(transportationType)
    ) {
      return NextResponse.json(
        {
          error: "invalid_input",
          message:
            "employeeHrId, a positive distanceKm, trip dates, and a valid transportationType are required.",
        },
        { status: 400 },
      );
    }

    const preview = await previewManagerExpenseCalculation(access, {
      claimedTotalAmount:
        body.claimedTotalAmount != null ? Number(body.claimedTotalAmount) : 0,
      destinationArea: optionalString(body.destinationArea),
      destinationCity: optionalString(body.destinationCity),
      destinationCountry: optionalString(body.destinationCountry),
      destinationLabel: optionalString(body.destinationLabel),
      distanceKm,
      employeeHrId,
      expenseType,
      meetingAmount: optionalNumber(body.meetingAmount) ?? 0,
      otherAmount: optionalNumber(body.otherAmount) ?? 0,
      transportationType,
      travelCostAmount: optionalNumber(body.travelCostAmount),
      tripEndDate,
      tripStartDate,
    });

    return NextResponse.json({ preview });
  } catch (error) {
    const message =
      clientSafeErrorMessage(error, "Failed to preview calculation.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "preview_failed",
        message,
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
