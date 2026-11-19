import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { deleteSalesBatch, updateSalesBatchStatus } from "@/lib/sales/service";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { assertPermission, canAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    action: string;
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: every action below needs sales:approve (approve, reject) or sales:delete (delete), so a
    // caller holding neither is refused before the action is judged. Each branch still asks its own.
    if (!(await canAccess(access, "sales", "approve"))) await assertPermission(access, "sales", "delete");
    const { action, id } = await context.params;
    const actorUsername = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const actorDisplayName = access.loginId ?? access.hrId ?? access.role;

    if (action !== "approve" && action !== "reject" && action !== "delete") {
      return NextResponse.json(
        { success: false, error: "Unsupported sales import action." },
        { status: 400 },
      );
    }

    if (action === "delete") {
      await assertPermission(access, "sales", "delete");
      const deleted = await deleteSalesBatch(id, actorUsername, actorDisplayName);
      if (!deleted) {
        return NextResponse.json(
          { success: false, error: "Sales batch was not found." },
          { status: 404 },
        );
      }

      return NextResponse.json({
        success: true,
        message: "Sales sheet deleted.",
      });
    }

    await assertPermission(access, "sales", "approve");
    const detail = await updateSalesBatchStatus(
      id,
      action === "approve" ? "approved" : "rejected",
      actorUsername,
      actorDisplayName,
    );

    if (!detail) {
      return NextResponse.json(
        { success: false, error: "Sales batch was not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: detail,
      message:
        action === "approve"
          ? "Sales batch approved."
          : "Sales batch rejected.",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    // Carries the refusal from assertSalesBatchHoldsNoFrozenRecords through with its own status and
    // wording. Without this it would land as a bare 500 and read like a bug rather than a deliberate
    // block on destroying H1 history.
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error:
          clientSafeErrorMessage(error, "Sales import action failed."),
      },
      { status: 500 },
    );
  }
}
