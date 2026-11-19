import { NextResponse } from "next/server";
import { z } from "zod";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { isOutstationTransportationType } from "@/lib/outstation/manager-expense-input";
import { previewManagerExpenseCalculation } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { OutstationExpenseType } from "@/lib/outstation/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An amount or a distance as a number, or as text; Number() and optionalNumber() read both as before. */
const previewNumberField = z.union([z.number(), z.string()]).nullable().optional();
const previewTextField = z.string().nullable().optional();

/**
 * What the manual-expense modal's live preview sends (admin-manager-expense-modal.tsx). The required fields
 * and the transportation type are still judged below, with the route's own invalid_input answer.
 */
const PreviewBodySchema = z.object({
  claimedTotalAmount: previewNumberField,
  destinationArea: previewTextField,
  destinationCity: previewTextField,
  destinationCountry: previewTextField,
  destinationLabel: previewTextField,
  distanceKm: previewNumberField,
  employeeHrId: previewTextField,
  expenseType: previewTextField,
  meetingAmount: previewNumberField,
  otherAmount: previewNumberField,
  transportationType: previewTextField,
  travelCostAmount: previewNumberField,
  tripEndDate: previewTextField,
  tripStartDate: previewTextField,
});

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

    const parsedBody = await parseJsonBody(request, PreviewBodySchema, { fallback: {} });
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_input", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;

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
      !isOutstationTransportationType(transportationType)
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
