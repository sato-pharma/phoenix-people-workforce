import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildRawDistributorTemplate } from "@/lib/sales/raw-template";
import { SOS_MAPPING_XLSX_CONTENT_TYPE } from "@/lib/sales/sos-mapping-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-distributor RAW emergency template download. The file mimics this distributor's own raw
// export layout (from its recognition profile) so a filled copy is recognized by the normalizer.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const distributor = new URL(request.url).searchParams.get("distributor")?.trim() ?? "";
    if (!distributor) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }
    const { buffer } = await buildRawDistributorTemplate(distributor);
    const safeName = distributor.replace(/[^A-Za-z0-9._-]+/g, "-") || "distributor";
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="raw-template-${safeName}.xlsx"`,
        "Content-Type": SOS_MAPPING_XLSX_CONTENT_TYPE,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to build the raw template." },
      { status: 500 },
    );
  }
}
