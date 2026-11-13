import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  OUTSTATION_CLAIM_CHANGED_CODE,
  isOutstationClaimChangedError,
} from "@/lib/outstation/claim-revision";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import {
  approveOutstationRequestForPayroll,
  deleteOutstationRequestAsAdmin,
  getOutstationRequestById,
  rejectOutstationRequestAsAdmin,
} from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { logAppError } from "@/lib/error-monitor/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isOutstationPayrollLockError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("already been added to payroll");
}

function outstationWorkflowStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  // 409 for a claim that moved after the reviewer loaded it (or a screen that never said which
  // version it showed): nothing was decided, and the answer is to refresh and look again.
  if (
    isOutstationPayrollLockError(error) ||
    isWorkflowRegistryTransitionError(error) ||
    isOutstationClaimChangedError(error)
  ) {
    return 409;
  }
  return 500;
}

/** The error code a failed decision answers with — the claim-moved one is distinct so a screen can refresh on it. */
function outstationDecisionErrorCode(error: unknown, fallback: string) {
  if (isForbiddenError(error)) return "forbidden";
  return isOutstationClaimChangedError(error) ? OUTSTATION_CLAIM_CHANGED_CODE : fallback;
}

/** The version token the screen sends with a decision; blank when it sent none (the service refuses blank). */
function expectedRevisionFrom(body: { expectedRevision?: unknown }) {
  return typeof body.expectedRevision === "string" ? body.expectedRevision : "";
}

/**
 * Record why a decision on this route failed, unsanitised.
 *
 * Added 2026-09-03, after an approval failed three times from the admin screen and left NOTHING
 * anywhere to say why: no row change, no audit entry, no `app_error_events` record. Every handler
 * here catches its own error and returns `clientSafeErrorMessage`, so the real cause is discarded
 * at the moment it is known — the same hole closed on `/api/admin/outstation/expenses` on
 * 2026-08-12 for the same reason.
 *
 * The absence of an error row is therefore NOT evidence that no error occurred. That is exactly
 * how the first diagnosis of this incident went wrong: an empty `app_error_events` was read as
 * "the request never reached the server" when this route could not have recorded it either way.
 *
 * These routes are Super Admin only, so a Forbidden here is anomalous rather than routine and is
 * recorded too — the `role` field identifies a role sweep.
 *
 * Awaited, not fired-and-forgotten: the response is already failing, and a dropped log on the one
 * path that needs it is how this happened in the first place.
 */
async function recordOutstationDecisionFailure(input: {
  access: Awaited<ReturnType<typeof resolveAccessContext>> | null;
  action: string;
  error: unknown;
  requestId: string | null;
}) {
  await logAppError({
    hrId: input.access?.hrId ?? null,
    loginId: input.access?.loginId ?? null,
    message: `outstation ${input.action} (request ${input.requestId ?? "unknown"}): ${describeThrown(input.error)}`,
    role: input.access?.role ?? null,
    route: "/api/admin/outstation/[id]",
    routeType: "route-handler",
    source: "server",
    stack: input.error instanceof Error ? (input.error.stack ?? null) : null,
  }).catch(() => {
    // Never let the logger turn a failed decision into a crash. The response still goes.
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  let requestId: string | null = null;
  try {
    access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const { id: rawId } = await params;
    requestId = rawId;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }
    const requestRow = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
    if (!requestRow) {
      return NextResponse.json(
        { error: "outstation_not_found", message: "Outstation request was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ request: requestRow });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load outstation request.");
    await recordOutstationDecisionFailure({ access, action: "read", error, requestId });
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_request_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  let requestId: string | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const { id: rawId } = await params;
    requestId = rawId;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      comment?: string | null;
      expectedRevision?: string | null;
    };
    const result = await approveOutstationRequestForPayroll(id, access, {
      comment: typeof body.comment === "string" ? body.comment : null,
      expectedRevision: expectedRevisionFrom(body),
    });

    return NextResponse.json({
      expenseTripId: result.expenseTripId,
      alreadyApproved: result.alreadyApproved,
      message: result.alreadyApproved
        ? "This outstation request was already approved — nothing was changed."
        : "Outstation request approved and queued for payroll expense import.",
      payrollExpenseRows: result.payrollExpenseRows,
      request: result.request,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to approve outstation request.");
    await recordOutstationDecisionFailure({ access, action: "approve", error, requestId });
    return NextResponse.json(
      { error: outstationDecisionErrorCode(error, "outstation_approval_failed"), message, success: false },
      { status: outstationWorkflowStatus(error) },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  let requestId: string | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const { id: rawId } = await params;
    requestId = rawId;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      comment?: string | null;
      expectedRevision?: string | null;
    };
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (!comment) {
      return NextResponse.json(
        { error: "missing_rejection_reason", message: "A rejection reason is required." },
        { status: 400 },
      );
    }

    const rejected = await rejectOutstationRequestAsAdmin(id, access, {
      comment,
      expectedRevision: expectedRevisionFrom(body),
    });

    return NextResponse.json({
      message: "Outstation expense rejected.",
      request: rejected,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to reject outstation request.");
    await recordOutstationDecisionFailure({ access, action: "reject", error, requestId });
    return NextResponse.json(
      { error: outstationDecisionErrorCode(error, "outstation_rejection_failed"), message, success: false },
      { status: outstationWorkflowStatus(error) },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  let requestId: string | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "delete");
    const { id: rawId } = await params;
    requestId = rawId;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
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
    const message = clientSafeErrorMessage(error, "Unable to delete outstation request.");
    await recordOutstationDecisionFailure({ access, action: "delete", error, requestId });
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_delete_failed", message, success: false },
      { status: outstationWorkflowStatus(error) },
    );
  }
}
