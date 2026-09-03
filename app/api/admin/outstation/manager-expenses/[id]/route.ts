import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  deleteOutstationRequestAsAdmin,
  updateManagerExpenseAsAdmin,
} from "@/lib/outstation/service";
import { parseOutstationTypeFieldsPatch } from "@/lib/outstation/request-fields";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { ManagerExpenseAdminInput } from "@/lib/outstation/types";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isOutstationPayrollLockError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("already been added to payroll");
}

function isOutstationConcurrencyConflictError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("state changed");
}

function managerExpenseStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  if (
    isOutstationPayrollLockError(error) ||
    isOutstationConcurrencyConflictError(error) ||
    isWorkflowRegistryTransitionError(error)
  ) {
    return 409;
  }
  return 500;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as Partial<ManagerExpenseAdminInput>;
    const distanceKm = optionalNumber(body.distanceKm);
    const durationMinutes = optionalNumber(body.durationMinutes);

    if (
      body.destination !== undefined &&
      (!body.destination ||
        !Number.isFinite(body.destination.latitude) ||
        !Number.isFinite(body.destination.longitude))
    ) {
      return NextResponse.json(
        {
          error: "invalid_destination",
          message: "Provided destination must have valid coordinates.",
        },
        { status: 400 },
      );
    }

    if (
      body.distanceKm !== undefined &&
      (distanceKm == null || distanceKm <= 0)
    ) {
      return NextResponse.json(
        { error: "invalid_distance", message: "distanceKm must be a positive number." },
        { status: 400 },
      );
    }

    // A partial update may leave either type field out, but one it DOES carry has to be a value
    // the system recognises. Both are written straight to the row (expense_type /
    // transportation_type) and neither column has a CHECK constraint behind it, so an unrecognised
    // value persists: the `car` fuel branch stops firing, the train/bus ticket-evidence
    // requirement stops firing, and the campaign rule reads anything that is not exactly
    // "traveling" as "no rule". None of it errors.
    const outstationTypes = parseOutstationTypeFieldsPatch(body);
    if (!outstationTypes.ok) {
      return NextResponse.json(
        { error: outstationTypes.error, message: outstationTypes.message },
        { status: 400 },
      );
    }

    const input: Partial<ManagerExpenseAdminInput> = {
      ...body,
      ...outstationTypes.fields,
      ...(body.amWorkload !== undefined ? { amWorkload: optionalNumber(body.amWorkload) } : {}),
      ...(body.claimedTotalAmount !== undefined
        ? { claimedTotalAmount: Number(body.claimedTotalAmount ?? 0) }
        : {}),
      ...(body.distanceKm !== undefined && distanceKm != null ? { distanceKm } : {}),
      ...(body.durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(body.hrNotes !== undefined ? { hrNotes: optionalText(body.hrNotes) } : {}),
      ...(body.hrStatus !== undefined ? { hrStatus: optionalText(body.hrStatus) } : {}),
      ...(body.meetingAmount !== undefined ? { meetingAmount: optionalNumber(body.meetingAmount) } : {}),
      ...(body.notes !== undefined ? { notes: optionalText(body.notes) } : {}),
      ...(body.otherAmount !== undefined ? { otherAmount: optionalNumber(body.otherAmount) } : {}),
      ...(body.pmWorkload !== undefined ? { pmWorkload: optionalNumber(body.pmWorkload) } : {}),
      ...(body.travelCostAmount !== undefined
        ? { travelCostAmount: optionalNumber(body.travelCostAmount) }
        : {}),
      ...(body.tripType !== undefined ? { tripType: optionalText(body.tripType) } : {}),
    };

    const updated = await updateManagerExpenseAsAdmin(id, access, input);

    return NextResponse.json({
      message: "Outstation expense updated successfully.",
      request: updated,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Failed to update outstation expense.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_expense_update_failed",
        message,
        success: false,
      },
      { status: managerExpenseStatus(error) },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "delete");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const deleted = await deleteOutstationRequestAsAdmin(id, access);

    return NextResponse.json({
      linkedPayroll: deleted.linkedPayroll,
      message: "Outstation expense deleted.",
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Failed to delete outstation expense.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_expense_delete_failed",
        message,
        success: false,
      },
      { status: managerExpenseStatus(error) },
    );
  }
}
