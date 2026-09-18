import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { RESTRICTED_PRODUCT_CODES, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { listMergedDistributorProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { buildPhoenixTemplateWorkbook } from "@/lib/sales/normalizer/phoenix-template-workbook";
import { SOS_MAPPING_XLSX_CONTENT_TYPE } from "@/lib/sales/sos-mapping-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Phoenix UNIVERSAL upload template — one layout for every distributor, downloaded here, filled
// by the business, and uploaded back through the Source Normalizer's normal pipeline.
//
// The distributor dropdown is built from the SAME merged profile set the recognizer resolves a
// filled template against (`listMergedDistributorProfiles`), so the sheet can never offer a name the
// upload will then refuse.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "export");

    const [profiles, refs] = await Promise.all([
      listMergedDistributorProfiles(),
      loadSalesReferenceData({ includeCustomerBricks: false }),
    ]);

    const excluded = canViewRestrictedProducts(access.role) ? new Set<string>() : new Set(RESTRICTED_PRODUCT_CODES);
    const buffer = await buildPhoenixTemplateWorkbook({
      distributors: profiles.map((p) => ({ distributorCode: p.distributorCode, distributorName: p.distributorName })),
      products: refs.products
        .filter((p) => !excluded.has(p.productCode))
        .map((p) => ({ productCode: p.productCode, productName: p.productName, line: p.line })),
    });

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: "phoenix-template",
      entityType: "sos_phoenix_template_export",
      newValues: { distributors: profiles.length, products: refs.products.length },
      summary: "Source-of-Sales Phoenix universal upload template downloaded.",
    });

    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="phoenix-sales-template.xlsx"',
        "Content-Type": SOS_MAPPING_XLSX_CONTENT_TYPE,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to build the Phoenix template.") },
      { status: 500 },
    );
  }
}
