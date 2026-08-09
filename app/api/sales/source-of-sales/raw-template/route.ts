import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildRawDistributorTemplate } from "@/lib/sales/raw-template";
import { SOS_MAPPING_XLSX_CONTENT_TYPE } from "@/lib/sales/sos-mapping-templates";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
    // Surfaced by widening the export-audit guard in tests/access-registry-coverage.test.ts (its
    // old pattern only matched a slash-delimited "template", so this hyphenated route escaped it
    // exactly like the CRM master-export routes did). The file itself is a BLANK layout and
    // carries no customer data, but the registry's rule is that download routes are audited, and
    // recording who pulled which distributor's template is cheap.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: distributor,
      entityType: "sos_raw_template_export",
      newValues: { distributor },
      summary: "Source-of-Sales raw distributor template downloaded.",
    });
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
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to build the raw template.") },
      { status: 500 },
    );
  }
}
