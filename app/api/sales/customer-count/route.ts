import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadAdminCustomerCount } from "@/lib/sales/customer-count-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The Customer Count dashboard (owner, 24 Nov 2026: "a dashboard specialized for now customer
// count"). How many pharmacies bought, month by month, from the published closings.
//
// THE SAME GATE AS THE ADMIN CLOSING MATRIX (app/api/sales/monthly-closing/route.ts), term for term:
// Super Admin / system, SFE Manager and the CEO; sales:read for the CEO, sales:import otherwise.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system" && access.role !== "SFE Manager" && access.role !== "CEO") {
      return NextResponse.json(
        { success: false, error: "Forbidden: the Customer Count dashboard is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", access.role === "CEO" ? "read" : "import");

    const { searchParams } = new URL(request.url);
    const list = (name: string) => (searchParams.get(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const result = await loadAdminCustomerCount({
      access,
      lines: list("lines"),
      months: list("months"),
      fresh: searchParams.get("fresh") === "1",
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: result.payload });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to count the customers.") },
      { status: 500 },
    );
  }
}
