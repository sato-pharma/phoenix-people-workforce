import { NextResponse } from "next/server";
import { z } from "zod";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { isOutstationClaimChangedError } from "@/lib/outstation/claim-revision";
import { buildManagerExpenseAdminPatch } from "@/lib/outstation/manager-expense-input";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { outstationRequestNeverDeletedBody } from "@/lib/outstation/never-delete";
import { updateManagerExpenseAsAdmin } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isOutstationPayrollLockError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("already been added to payroll");
}

function isOutstationConcurrencyConflictError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("state changed");
}

/**
 * What the manual-expense modal sends on an edit: the whole form plus the version it opened on. The body is
 * handed whole to buildManagerExpenseAdminPatch, which judges every field by name with its own words, so the
 * schema is loose and names only the version this route reads itself.
 */
const ManagerExpenseEditBodySchema = z.looseObject({
  expectedRevision: z.string().nullable().optional(),
});

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

    const parsedBody = await parseJsonBody(request, ManagerExpenseEditBodySchema, { fallback: {} });
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const patch = buildManagerExpenseAdminPatch(body);
    if (!patch.ok) {
      return NextResponse.json(
        { error: patch.error, message: patch.message },
        { status: 400 },
      );
    }

    const updated = await updateManagerExpenseAsAdmin(id, access, patch.input, {
      expectedRevision: typeof body.expectedRevision === "string" ? body.expectedRevision : undefined,
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

/**
 * 🔴 An expense request is never deleted (owner, 24 Nov 2026). A DELETE is refused, whoever sends it;
 * reject the request instead. The database trigger phx_outstation_requests_never_deleted refuses it too.
 */
export async function DELETE(request: Request) {
  const csrfError = assertSameOriginMutation(request);
  if (csrfError) return csrfError;
  // Who may not act here is refused first (401/403), exactly as before; only then the refusal itself.
  try {
    await assertOutstationAdminAccess(await resolveAccessContext(request), "delete");
  } catch (error) {
    const forbidden = isForbiddenError(error);
    return NextResponse.json(
      { error: forbidden ? "forbidden" : "outstation_access_failed", message: forbidden ? "You cannot act on expense requests." : "Access could not be checked.", success: false },
      { status: forbidden ? 403 : 500 },
    );
  }
  return NextResponse.json(outstationRequestNeverDeletedBody(), { status: 405 });
}
