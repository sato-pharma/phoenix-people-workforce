import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  deleteSourceOfSalesProduct,
  updateSourceOfSalesProduct,
  type SourceOfSalesProductInput,
} from "@/lib/sales/monthly-distributor-import";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    code: string;
  }>;
};

async function productInputFromRequest(request: Request): Promise<SourceOfSalesProductInput> {
  const body = await request.json();
  return body as SourceOfSalesProductInput;
}

function errorResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { success: false, error: clientSafeErrorMessage(error, fallback) },
    { status: 500 },
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "update");

    const { code } = await context.params;
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const product = await updateSourceOfSalesProduct({
      actorLoginId,
      product: await productInputFromRequest(request),
      productCode: decodeURIComponent(code),
    });

    return NextResponse.json({
      success: true,
      data: product,
      message: "Source of Sales product updated.",
    });
  } catch (error) {
    return errorResponse(error, "Failed to update Source of Sales product.");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "delete");

    const { code } = await context.params;
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const deleted = await deleteSourceOfSalesProduct({
      actorLoginId,
      productCode: decodeURIComponent(code),
    });

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: "Source of Sales product was not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Source of Sales product deleted.",
    });
  } catch (error) {
    return errorResponse(error, "Failed to delete Source of Sales product.");
  }
}
