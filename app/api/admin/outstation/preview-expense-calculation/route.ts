import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { previewManagerExpenseCalculation } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { OutstationTransportationType } from "@/lib/outstation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const body = (await request.json().catch(() => ({}))) as {
      claimedTotalAmount?: number;
      distanceKm?: number;
      employeeHrId?: string;
      transportationType?: OutstationTransportationType;
      tripEndDate?: string;
      tripStartDate?: string;
    };

    const employeeHrId =
      typeof body.employeeHrId === "string" ? body.employeeHrId.trim() : "";
    const distanceKm = Number(body.distanceKm);
    const tripStartDate =
      typeof body.tripStartDate === "string" ? body.tripStartDate.trim() : "";
    const tripEndDate =
      typeof body.tripEndDate === "string" ? body.tripEndDate.trim() : "";
    const transportationType = body.transportationType;

    if (
      !employeeHrId ||
      !Number.isFinite(distanceKm) ||
      distanceKm <= 0 ||
      !tripStartDate ||
      !tripEndDate ||
      !transportationType ||
      !["car", "train", "bus", "other"].includes(transportationType)
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
      distanceKm,
      employeeHrId,
      transportationType,
      tripEndDate,
      tripStartDate,
    });

    return NextResponse.json({ preview });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to preview calculation.";
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "preview_failed",
        message,
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
