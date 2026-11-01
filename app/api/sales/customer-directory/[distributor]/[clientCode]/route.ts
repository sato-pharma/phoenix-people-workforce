import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadCustomerSales } from "@/lib/sales/customer-directory";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ clientCode: string; distributor: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    // Mirrors the page gate (app/(admin)/sales/customer-directory/page.tsx): Super Admin and SFE
    // Manager both reach the workspace, so both must be able to read what it asks for.
    if (access.role !== "Super Admin" && access.role !== "SFE Manager" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customer Directory is restricted to Super Admin and SFE Manager." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { clientCode, distributor } = await context.params;
    const { searchParams } = new URL(request.url);
    const data = await loadCustomerSales(
      {
        clientCode: decodeURIComponent(clientCode),
        distributorCode: decodeURIComponent(distributor),
        fromPeriod: searchParams.get("from"),
        toPeriod: searchParams.get("to"),
      },
      access.role,
    );

    if (!data) {
      return NextResponse.json({ success: false, error: "Customer not found." }, { status: 404 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load customer sales.") },
      { status: 500 },
    );
  }
}
