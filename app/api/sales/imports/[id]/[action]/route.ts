import { NextResponse } from "next/server";

import { deleteSalesBatch, updateSalesBatchStatus } from "@/lib/sales/service";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

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
    const { action, id } = await context.params;
    const actorUsername = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
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
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Sales import action failed.",
      },
      { status: 500 },
    );
  }
}
