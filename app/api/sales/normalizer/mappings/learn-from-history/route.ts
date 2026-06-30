import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { learnFromImportHistory } from "@/lib/sales/normalizer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mine all source_of_sales_import_rows for product_name→product_code and client_code→brick_id pairs
// and upsert them into the alias tables. Idempotent. Scoped to a single distributor when provided.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { distributorCode?: string };
    const distributorCode = typeof body.distributorCode === "string" && body.distributorCode.trim()
      ? body.distributorCode.trim()
      : undefined;

    const result = await learnFromImportHistory(distributorCode);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Mine history failed." }, { status: 500 });
  }
}
