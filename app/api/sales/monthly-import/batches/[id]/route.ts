import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { deleteSourceOfSalesUploadBatch } from "@/lib/sales/monthly-distributor-import";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "delete");

    const { id } = await context.params;
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const deleted = await deleteSourceOfSalesUploadBatch({ actorLoginId, batchId: id });

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: "Uploaded Source of Sales sheet was not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Uploaded Source of Sales sheet deleted.",
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to delete uploaded Source of Sales sheet."),
      },
      { status: 500 },
    );
  }
}
