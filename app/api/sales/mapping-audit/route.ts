import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listMappingAuditEntries, type MappingAuditEntityType } from "@/lib/sales/mapping-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only "recent changes" feed for the distributor column editors. Gated by the resource that owns the
// entity: weekly_distributor_profile → weekly_sales, everything else → sales. Best-effort underneath.

const VALID_ENTITIES: MappingAuditEntityType[] = [
  "customer_map", "product_alias", "territory_alias", "area_alias", "region_alias", "distributor_profile", "weekly_distributor_profile",
];

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const entityTypeParam = url.searchParams.get("entityType");
    const entityType = VALID_ENTITIES.includes(entityTypeParam as MappingAuditEntityType) ? (entityTypeParam as MappingAuditEntityType) : undefined;
    const distributorCode = url.searchParams.get("distributorCode");

    // Permission scoped to the owning module.
    if (entityType === "weekly_distributor_profile") {
      await assertPermission(access, "weekly_sales", "read");
    } else {
      await assertPermission(access, "sales", "read");
    }

    const entries = await listMappingAuditEntries({ entityType, distributorCode, limit: 50 });
    return NextResponse.json({ success: true, entries });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to load history." }, { status: 500 });
  }
}
