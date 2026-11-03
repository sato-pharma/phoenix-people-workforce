import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { isOutstationClaimChangedError } from "@/lib/outstation/claim-revision";
import { buildManagerExpenseAdminPatch } from "@/lib/outstation/manager-expense-input";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import {
  deleteOutstationRequestAsAdmin,
  updateManagerExpenseAsAdmin,
} from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
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
    isOutstationClaimChangedError(error) ||
    isWorkflowRegistryTransitionError(error)
  ) {
    return 409;
  }
  return 500;
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
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const patch = buildManagerExpenseAdminPatch(body);
    if (!patch.ok) {
      return NextResponse.json(
        { error: patch.error, message: patch.message },
        { status: 400 },
      );
    }

    const updated = await updateManagerExpenseAsAdmin(id, access, patch.input, {
      expectedRevision: typeof body?.expectedRevision === "string" ? body.expectedRevision : undefined,
    });

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
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
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
