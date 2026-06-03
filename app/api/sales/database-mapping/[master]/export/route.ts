import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getMasterDefinition, requiredReferenceMasters, type MasterKey, type MasterRowRecord } from "@/lib/sales/master-data/definitions";
import { buildMasterWorkbook } from "@/lib/sales/master-data/export-workbook";
import { listMasterRows } from "@/lib/sales/master-data/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ master: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");

    const { master } = await context.params;
    const definition = getMasterDefinition(master);
    if (!definition) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const rows = await listMasterRows(definition.master);
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
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export master sheet." },
      { status: 500 },
    );
  }
}
