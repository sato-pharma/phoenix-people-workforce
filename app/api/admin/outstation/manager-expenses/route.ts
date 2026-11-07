import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  INVALID_EXPENSE_TYPE,
  INVALID_TRANSPORTATION_TYPE,
  isOutstationExpenseType,
  isOutstationTransportationType,
} from "@/lib/outstation/manager-expense-input";
import { createManagerExpenseAsAdmin } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { ManagerExpenseAdminInput } from "@/lib/outstation/types";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function managerExpenseCreateStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  if (isWorkflowRegistryTransitionError(error)) return 409;
  return 500;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    const rawDistanceKm = Number(body.distanceKm);
    const distanceKm = Number.isFinite(rawDistanceKm) ? rawDistanceKm : 0;
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

    if (!isOutstationExpenseType(expenseType)) {
      return NextResponse.json(
        { error: INVALID_EXPENSE_TYPE.error, message: INVALID_EXPENSE_TYPE.message },
        { status: 400 },
      );
    }

    // A Meeting entry never prices travel, so it is the one expense type that does not need a
    // real distance — the modal stops asking for one once Meeting is selected.
    if (expenseType !== "meeting" && (!Number.isFinite(distanceKm) || distanceKm <= 0)) {
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

    // "No ticket" is priced by the system from the employee's own home and arrival capture (owner,
    // 2026-11-07), so HR never records one by hand — an edit of an existing No-ticket claim keeps it.
    if (transportationType === "no_ticket") {
      return NextResponse.json(
        {
          error: "invalid_transportation_type",
          message: "No ticket is chosen by the employee on Submit Expense. Record this trip as Car, Train, Bus or Other.",
        },
        { status: 400 },
      );
    }

    if (!isOutstationTransportationType(transportationType)) {
      return NextResponse.json(
        {
          error: INVALID_TRANSPORTATION_TYPE.error,
          message: INVALID_TRANSPORTATION_TYPE.message,
        },
        { status: 400 },
      );
    }

    if (
      body.meetingInvoiceDataUrl != null &&
      (typeof body.meetingInvoiceDataUrl !== "string" ||
        !body.meetingInvoiceDataUrl.startsWith("data:"))
    ) {
      return NextResponse.json(
        {
          error: "invalid_meeting_invoice",
          message: "meetingInvoiceDataUrl must be an uploaded PDF, JPG, or PNG file.",
        },
        { status: 400 },
      );
    }

    const input: ManagerExpenseAdminInput = {
      amWorkload: typeof body.amWorkload === "number" ? body.amWorkload : null,
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      destination,
      distanceKm,
      durationMinutes:
        body.durationMinutes != null ? Number(body.durationMinutes) : null,
      employeeHrId,
      expenseType,
      meetingAmount: typeof body.meetingAmount === "number" ? body.meetingAmount : null,
      meetingInvoiceDataUrl:
        typeof body.meetingInvoiceDataUrl === "string" ? body.meetingInvoiceDataUrl : null,
      meetingInvoiceFileName:
        typeof body.meetingInvoiceFileName === "string"
          ? body.meetingInvoiceFileName.trim() || null
          : null,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
      otherAmount: typeof body.otherAmount === "number" ? body.otherAmount : null,
      pmWorkload: typeof body.pmWorkload === "number" ? body.pmWorkload : null,
      routePolyline:
        typeof body.routePolyline === "string" ? body.routePolyline : null,
      transportationType,
      travelCostAmount: optionalNumber(body.travelCostAmount),
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
    const message = clientSafeErrorMessage(error, "Failed to add manual outstation expense.");
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
