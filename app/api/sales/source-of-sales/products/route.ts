import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canViewRestrictedProducts, isRestrictedProductCode } from "@/lib/sales/access-scope";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  createSourceOfSalesProduct,
  listSourceOfSalesProducts,
  type SourceOfSalesProductInput,
} from "@/lib/sales/monthly-distributor-import";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const data = await listSourceOfSalesProducts();
    // Confidential products (LA003 / LA004) are listed only for CEO / Super Admin.
    const visible = canViewRestrictedProducts(access.role)
      ? data
      : data.filter((product) => !isRestrictedProductCode(product.productCode));
    return NextResponse.json({ success: true, data: visible });
  } catch (error) {
    return errorResponse(error, "Failed to load Source of Sales products.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "create");
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const product = await createSourceOfSalesProduct({
      actorLoginId,
      product: await productInputFromRequest(request),
    });

    return NextResponse.json({
      success: true,
      data: product,
      message: "Source of Sales product added.",
    });
  } catch (error) {
    return errorResponse(error, "Failed to add Source of Sales product.");
  }
}
