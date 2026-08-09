import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: the customer -> brick crosswalk for the Database Validation tab, optionally filtered to one
// distributor. Admin-gated; no mutation.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const distributor = new URL(request.url).searchParams.get("distributor") ?? "";
    const rows = await listCustomerMap(distributor && distributor !== "ALL" ? { distributorCode: distributor } : undefined);
    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to load customer map.") }, { status: 500 });
  }
}
