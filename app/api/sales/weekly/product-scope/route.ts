import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { replaceWeeklyProductScope } from "@/lib/sales/weekly/access";
import { loadWeeklyProductScopeAdmin } from "@/lib/sales/weekly/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Managing which products a PM/GPM/Marketing Manager owns is an SFE/admin task — gated on the
// weekly_sales `update` action (Super Admin + SFE Manager), not the read audience.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const data = await loadWeeklyProductScopeAdmin();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");

    const body = (await request.json()) as { hrId?: unknown; productCodes?: unknown };
    const hrId = String(body?.hrId ?? "").trim();
    if (!hrId) {
      return NextResponse.json({ success: false, error: "An HR_ID is required." }, { status: 400 });
    }
    const productCodes = Array.isArray(body?.productCodes)
      ? body.productCodes.map((code) => String(code ?? "").trim()).filter(Boolean)
      : [];

    const actorId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await replaceWeeklyProductScope(hrId, productCodes, actorId);

    const data = await loadWeeklyProductScopeAdmin();
    return NextResponse.json({ success: true, data, message: "Product access updated." });
  } catch (error) {
    return mapError(error);
  }
}

function mapError(error: unknown) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : "Failed to update product access." },
    { status: 500 },
  );
}
