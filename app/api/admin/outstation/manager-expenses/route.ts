import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { createManagerExpenseAsAdmin } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { ManagerExpenseAdminInput } from "@/lib/outstation/types";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function managerExpenseCreateStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  if (isWorkflowRegistryTransitionError(error)) return 409;
  return 500;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const body = (await request.json().catch(() => ({}))) as Partial<ManagerExpenseAdminInput>;

    const employeeHrId =
      typeof body.employeeHrId === "string" ? body.employeeHrId.trim() : "";
    const destination = body.destination;
    const distanceKm = Number(body.distanceKm);
    const tripStartDate =
      typeof body.tripStartDate === "string" ? body.tripStartDate.trim() : "";
    const tripEndDate =
      typeof body.tripEndDate === "string" ? body.tripEndDate.trim() : "";
    const expenseType = body.expenseType;
    const transportationType = body.transportationType;

    if (!employeeHrId) {
      return NextResponse.json(
        { error: "missing_hr_id", message: "employeeHrId is required." },
        { status: 400 },
      );
    }

    if (
      !destination ||
      !destination.placeId ||
      !destination.label ||
      !Number.isFinite(destination.latitude) ||
      !Number.isFinite(destination.longitude)
    ) {
      return NextResponse.json(
        {
          error: "invalid_destination",
          message: "A valid Google Places destination with coordinates is required.",
        },
        { status: 400 },
      );
    }

    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      return NextResponse.json(
        { error: "invalid_distance", message: "distanceKm must be a positive number." },
        { status: 400 },
      );
    }

    if (!tripStartDate || !tripEndDate) {
      return NextResponse.json(
        { error: "missing_dates", message: "tripStartDate and tripEndDate are required." },
        { status: 400 },
      );
    }

    if (!expenseType || !["traveling", "meeting", "other"].includes(expenseType)) {
      return NextResponse.json(
        { error: "invalid_expense_type", message: "expenseType must be traveling, meeting, or other." },
        { status: 400 },
      );
    }

    if (
      !transportationType ||
      !["car", "train", "bus", "other"].includes(transportationType)
    ) {
      return NextResponse.json(
        {
          error: "invalid_transportation_type",
          message: "transportationType must be car, train, bus, or other.",
        },
        { status: 400 },
      );
    }

    const input: ManagerExpenseAdminInput = {
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      destination,
      distanceKm,
      durationMinutes:
        body.durationMinutes != null ? Number(body.durationMinutes) : null,
      employeeHrId,
      expenseType,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
      routePolyline:
        typeof body.routePolyline === "string" ? body.routePolyline : null,
      transportationType,
      tripEndDate,
      tripStartDate,
    };

    const created = await createManagerExpenseAsAdmin(access, input);

    return NextResponse.json({
      message: "Manual outstation expense added successfully.",
      request: created,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add manual outstation expense.";
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_expense_create_failed",
        message,
        success: false,
      },
      { status: managerExpenseCreateStatus(error) },
    );
  }
}
