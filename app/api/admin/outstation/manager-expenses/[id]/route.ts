import { NextResponse } from "next/server";

import { assertAdminManagerExpenseAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  deleteOutstationRequestAsAdmin,
  updateManagerExpenseAsAdmin,
} from "@/lib/outstation/service";
import type { ManagerExpenseAdminInput } from "@/lib/outstation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertAdminManagerExpenseAccess(access);

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
      message: "Manager expense updated successfully.",
      request: updated,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update manager expense.";
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "manager_expense_update_failed",
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
    await assertAdminManagerExpenseAccess(access);

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
      message: "Manager expense deleted.",
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete manager expense.";
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "manager_expense_delete_failed",
        message,
        success: false,
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
