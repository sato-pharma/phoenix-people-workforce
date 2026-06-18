import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { addCustomerMapRow, deleteCustomerMapRow, listCustomerMapPage } from "@/lib/sales/normalizer/customer-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

// GET — paginated + searchable customer→brick rows for one distributor (Mapping Database, Monthly).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const params = new URL(request.url).searchParams;
    const distributorCode = params.get("distributor")?.trim() ?? "";
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    const page = await listCustomerMapPage({
      distributorCode,
      search: params.get("search") ?? "",
      limit: Number(params.get("limit")) || undefined,
      offset: Number(params.get("offset")) || undefined,
    });
    return NextResponse.json({ success: true, ...page });
  } catch (error) {
    return fail(error, "Failed to load customer map.");
  }
}

// POST — single-row upsert (edit/add) or delete.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as {
      action?: "upsert" | "delete";
      distributorCode?: string;
      customerCode?: string;
      customerName?: string;
      address?: string;
      brickId?: string;
    };
    const distributorCode = String(body.distributorCode ?? "").trim();
    const customerCode = String(body.customerCode ?? "").trim();
    if (body.action === "delete") {
      await deleteCustomerMapRow({ actorLoginId: actor(access), distributorCode, customerCode });
      return NextResponse.json({ success: true, message: "Mapping deleted." });
    }
    await addCustomerMapRow({
      actorLoginId: actor(access),
      distributorCode,
      customerCode,
      customerName: body.customerName,
      address: body.address,
      brickId: String(body.brickId ?? "").trim(),
    });
    return NextResponse.json({ success: true, message: "Mapping saved." });
  } catch (error) {
    return fail(error, "Failed to save customer mapping.");
  }
}
