import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { listEditableTemplates, resetSalesOpsTemplate, saveSalesOpsTemplate } from "@/lib/sales-operations/profile-store";
import type { BrickLookupStrategy } from "@/lib/sales-operations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mapping edits are a Super-Admin / system-scope operation (server boundary; the sidebar/page gate is
// UX only). assertPermission(sales, import) is the resource gate; this is the elevation check.
function requireMappingAdmin(access: AccessContext): void {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw Object.assign(new Error("Forbidden: distributor mapping editing requires Super Admin."), { name: "ForbiddenError" });
  }
}

function isForbidden(error: unknown): boolean {
  return isForbiddenError(error) || (error instanceof Error && /^Forbidden:/.test(error.message));
}

const STRATEGIES = new Set<BrickLookupStrategy>(["customer-code", "brick-name", "office-allocation"]);

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

// GET — list every distributor's current effective mapping (DB-first; isCustom flags an override).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    requireMappingAdmin(access);
    const templates = await listEditableTemplates();
    return NextResponse.json({ success: true, data: templates });
  } catch (error) {
    if (isForbidden(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to load profiles." }, { status: 500 });
  }
}

// PUT — save one distributor's mapping (multi-column per field).
export async function PUT(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    requireMappingAdmin(access);
    const body = (await request.json()) as Record<string, unknown>;
    const distributorCode = String(body.distributorCode ?? "").trim();
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    const brickLookup = String(body.brickLookup ?? "customer-code") as BrickLookupStrategy;
    if (!STRATEGIES.has(brickLookup)) return NextResponse.json({ success: false, error: "Invalid brick lookup strategy." }, { status: 400 });

    await saveSalesOpsTemplate({
      distributorCode,
      brickLookup,
      customerCodeHeaders: strArray(body.customerCodeHeaders),
      customerNameHeaders: strArray(body.customerNameHeaders),
      customerAddressHeaders: strArray(body.customerAddressHeaders),
      brickNameHeaders: strArray(body.brickNameHeaders),
      productNameHeaders: strArray(body.productNameHeaders),
      productCodeHeaders: strArray(body.productCodeHeaders),
      qtyHeaders: strArray(body.qtyHeaders),
      dateHeaders: strArray(body.dateHeaders),
      bonusHeaders: strArray(body.bonusHeaders),
      regionOnly: Boolean(body.regionOnly),
      dateFormat: body.dateFormat === "month-first" ? "month-first" : "day-first",
      updatedBy: access.hrId ?? access.loginId ?? "system",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbidden(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to save the mapping." }, { status: 500 });
  }
}

// DELETE — reset one distributor back to the code default.
export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    requireMappingAdmin(access);
    const distributor = new URL(request.url).searchParams.get("distributor") ?? "";
    if (!distributor.trim()) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    await resetSalesOpsTemplate(distributor.trim());
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbidden(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to reset the mapping." }, { status: 500 });
  }
}
