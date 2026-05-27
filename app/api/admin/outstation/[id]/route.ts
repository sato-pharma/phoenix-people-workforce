import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  approveOutstationRequestForPayroll,
  deleteOutstationRequestAsAdmin,
  getOutstationRequestById,
  rejectOutstationRequestAsAdmin,
} from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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
    const message = error instanceof Error ? error.message : "Unable to load outstation request.";
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
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as { comment?: string | null };
    const result = await approveOutstationRequestForPayroll(id, access, {
      comment: typeof body.comment === "string" ? body.comment : null,
    });

    return NextResponse.json({
      expenseTripId: result.expenseTripId,
      message: "Outstation request approved and queued for payroll expense import.",
      payrollExpenseRows: result.payrollExpenseRows,
      request: result.request,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to approve outstation request.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_approval_failed", message, success: false },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
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
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as { comment?: string | null };
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (!comment) {
      return NextResponse.json(
        { error: "missing_rejection_reason", message: "A rejection reason is required." },
        { status: 400 },
      );
    }

    const rejected = await rejectOutstationRequestAsAdmin(id, access, { comment });

    return NextResponse.json({
      message: "Outstation expense rejected.",
      request: rejected,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reject outstation request.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_rejection_failed", message, success: false },
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
    const message = error instanceof Error ? error.message : "Unable to delete outstation request.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_delete_failed", message, success: false },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
