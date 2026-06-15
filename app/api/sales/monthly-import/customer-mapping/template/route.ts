import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { SOS_MAPPING_XLSX_CONTENT_TYPE, buildSosCustomerBrickTemplate } from "@/lib/sales/sos-mapping-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const distributor = new URL(request.url).searchParams.get("distributor")?.trim();
    if (!distributor) {
      return NextResponse.json({ success: false, error: "A distributor is required." }, { status: 400 });
    }
    const buffer = await buildSosCustomerBrickTemplate(distributor);
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="source-of-sales-customer-mapping-${distributor}.xlsx"`,
        "Content-Type": SOS_MAPPING_XLSX_CONTENT_TYPE,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to build the customer mapping template." },
      { status: 500 },
    );
  }
}
