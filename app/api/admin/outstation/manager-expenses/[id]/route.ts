import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  deleteOutstationRequestAsAdmin,
  updateManagerExpenseAsAdmin,
} from "@/lib/outstation/service";
import type { ManagerExpenseAdminInput } from "@/lib/outstation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isOutstationPayrollLockError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("already been added to payroll");
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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

    if (
      body.destination !== undefined &&
      (!body.destination ||
        !body.destination.placeId ||
        !Number.isFinite(body.destination.latitude) ||
        !Number.isFinite(body.destination.longitude))
    ) {
      return NextResponse.json(
        {
          error: "invalid_destination",
          message: "Provided destination must be a valid Google Places result with coordinates.",
        },
        { status: 400 },
      );
    }

    if (
      body.distanceKm !== undefined &&
      (!Number.isFinite(body.distanceKm) || body.distanceKm <= 0)
    ) {
      return NextResponse.json(
        { error: "invalid_distance", message: "distanceKm must be a positive number." },
        { status: 400 },
      );
    }

    const updated = await updateManagerExpenseAsAdmin(id, access, body);

    return NextResponse.json({
      message: "Outstation expense updated successfully.",
      request: updated,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update outstation expense.";
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_expense_update_failed",
        message,
        success: false,
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
    const message = error instanceof Error ? error.message : "Failed to delete outstation expense.";
    const status = isForbiddenError(error) ? 403 : isOutstationPayrollLockError(error) ? 409 : 500;
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_expense_delete_failed",
        message,
        success: false,
      },
      { status },
    );
  }
}
