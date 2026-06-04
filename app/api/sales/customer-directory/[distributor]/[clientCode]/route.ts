import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadCustomerSales } from "@/lib/sales/customer-directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ clientCode: string; distributor: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customer Directory is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { clientCode, distributor } = await context.params;
    const { searchParams } = new URL(request.url);
    const data = await loadCustomerSales({
      clientCode: decodeURIComponent(clientCode),
      distributorCode: decodeURIComponent(distributor),
      fromPeriod: searchParams.get("from"),
      toPeriod: searchParams.get("to"),
    });

    if (!data) {
      return NextResponse.json({ success: false, error: "Customer not found." }, { status: 404 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load customer sales." },
      { status: 500 },
    );
  }
}
