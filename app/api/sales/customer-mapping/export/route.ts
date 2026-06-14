import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { CustomerDirectoryFilters } from "@/lib/sales/customer-directory";
import { loadCustomerMapping } from "@/lib/sales/customer-mapping";
import { buildCustomerMappingWorkbook } from "@/lib/sales/customer-mapping-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customer Mapping export is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "export");

    const body = (await request.json().catch(() => ({}))) as CustomerDirectoryFilters;
    const filters: CustomerDirectoryFilters = {
      areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
      brickCodes: Array.isArray(body.brickCodes) ? body.brickCodes : [],
      distributorCodes: Array.isArray(body.distributorCodes) ? body.distributorCodes : [],
      fromPeriod: typeof body.fromPeriod === "string" ? body.fromPeriod : null,
      regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
      search: typeof body.search === "string" ? body.search : "",
      toPeriod: typeof body.toPeriod === "string" ? body.toPeriod : null,
    };

    const { consolidated, rows } = await loadCustomerMapping(filters);
    const buffer = await buildCustomerMappingWorkbook({ consolidated, rows });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-customer-mapping.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export Customer Mapping." },
      { status: 500 },
    );
  }
}
