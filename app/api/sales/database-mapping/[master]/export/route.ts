import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { stripRestrictedMasterProductRows } from "@/lib/sales/access-scope";
import { getMasterDefinition, requiredReferenceMasters, type MasterKey, type MasterRowRecord } from "@/lib/sales/master-data/definitions";
import { buildMasterWorkbook } from "@/lib/sales/master-data/export-workbook";
import { listMasterRows } from "@/lib/sales/master-data/list";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ master: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:database-mapping" });

    const { master } = await context.params;
    const definition = getMasterDefinition(master);
    if (!definition) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const rawRows = await listMasterRows(definition.master);
    // Confidential products (LA003 / LA004 / SS001) are exported only for CEO / Super Admin.
    const rows =
      definition.master === "products" ? stripRestrictedMasterProductRows(rawRows, access.role) : rawRows;
    const referenceMasters = requiredReferenceMasters(definition);
    const referenceEntries = await Promise.all(
      referenceMasters.map(async (master) => [master, await listMasterRows(master)] as const),
    );
    const referenceData = Object.fromEntries(referenceEntries) as Partial<Record<MasterKey, MasterRowRecord[]>>;
    const buffer = await buildMasterWorkbook(definition, rows, referenceData);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `phoenix-${definition.master}-master-${stamp}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to export master sheet.") },
      { status: 500 },
    );
  }
}
