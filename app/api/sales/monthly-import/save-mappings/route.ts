import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist the unknowns the user confirmed on the Missing/AI panel. Each mapping is validated against
// the masters inside saveMappings (product code / brick id), then upserted into the alias tables.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { mappings?: MappingInput[]; distributorCode?: string };
    // A distributor may be supplied at the top level (the Mapping tab's selected distributor). Product
    // and customer aliases are per-distributor, so fall back to it for any row that didn't carry its own.
    const topDistributor = String(body.distributorCode ?? "").trim();
    const mappings = (Array.isArray(body.mappings) ? body.mappings : [])
      .filter((m) => m && m.raw && m.code && (m.type === "product" || m.type === "territory" || m.type === "customer"))
      .map((m) =>
        (m.type === "product" || m.type === "customer") && !String(m.distributorCode ?? "").trim()
          ? { ...m, distributorCode: topDistributor }
          : m,
      );
    if (mappings.length === 0) {
      return NextResponse.json({ success: false, error: "No mappings to save." }, { status: 400 });
    }

    const result = await saveMappings(mappings);
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: "source_of_sales_product_aliases",
      entityType: "sales_import_batch",
      newValues: { count: mappings.length, saved: result.saved, skipped: result.skipped, invalid: result.invalid, source: "mapping_save" },
      summary: `Mapping save — ${result.saved} saved from ${mappings.length} submitted (${result.skipped} skipped, ${result.invalid} invalid).`,
    });
    return NextResponse.json({
      success: true,
      result,
      invalidEntries: result.invalidEntries,
      message: `${result.saved} mappings saved (${result.skipped} skipped, ${result.invalid} invalid).`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save mappings." },
      { status: 500 },
    );
  }
}
