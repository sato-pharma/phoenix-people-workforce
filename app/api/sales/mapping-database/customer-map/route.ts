import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  addCustomerMapRow,
  applyHistoricalReconciliation,
  deleteCustomerMapRow,
  listCustomerMapPage,
  previewHistoricalReconciliation,
} from "@/lib/sales/normalizer/customer-map";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
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
      source: params.get("source") ?? "",
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
      action?: "upsert" | "delete" | "reconcile-preview" | "reconcile-apply";
      distributorCode?: string;
      customerCode?: string;
      customerName?: string;
      address?: string;
      brickId?: string;
    };
    const distributorCode = String(body.distributorCode ?? "").trim();
    const customerCode = String(body.customerCode ?? "").trim();
    if (body.action === "delete") {
      // DELETING A MAPPING NEEDS sales:delete, NOT sales:import.
      //
      // The POST asserts sales:import once, at the top, for every action it serves — and the
      // matrix hands `sales: ["read", "import", "export"]` to SFE Manager, who therefore reached
      // this branch without ever holding the delete grant that `allActions` reserves for Super
      // Admin. That the two are meant to differ is settled elsewhere in the same module:
      // app/api/sales/database-mapping/[master]/[key]/route.ts asserts sales:delete for its
      // DELETE, and `reconcile-apply` a few lines below adds its own Super-Admin gate precisely
      // because it is destructive.
      //
      // The customer map is the crosswalk that decides which AREA is credited with a sale. Delete
      // a row and every later import row for that customer resolves to no brick, so its units fall
      // out of area attribution: the area's Monthly Closing under-reports by that customer's whole
      // volume while the company total still counts it. The loss is silent — a mapping that is
      // gone looks exactly like a customer that was never mapped.
      //
      // Pinned by tests/mapping-delete-needs-delete-permission.test.ts.
      await assertPermission(access, "sales", "delete");
      await deleteCustomerMapRow({ actorLoginId: actor(access), distributorCode, customerCode });
      return NextResponse.json({ success: true, message: "Mapping deleted." });
    }
    if (body.action === "reconcile-preview") {
      // Read-only dry-run — no elevated permission needed beyond the sales:import already asserted above.
      const preview = await previewHistoricalReconciliation({ distributorCode, customerCode });
      return NextResponse.json({ success: true, preview });
    }
    if (body.action === "reconcile-apply") {
      // This overwrites historical, already-reported sales rows across every batch that customer
      // appears in — a bigger blast radius than a single mapping edit, so it's Super-Admin only,
      // matching the gate on the Normalizer's own admin-only import routes.
      if (access.role !== "Super Admin" && access.scope !== "system") {
        return NextResponse.json({ success: false, error: "Forbidden: historical reconciliation is restricted to the admin account." }, { status: 403 });
      }
      const result = await applyHistoricalReconciliation({ distributorCode, customerCode, actorLoginId: actor(access) });
      return NextResponse.json({
        success: true,
        message: result.updatedRows > 0
          ? `${result.updatedRows} historical row(s) reconciled across ${result.refreshedBatches} batch(es).`
          : "No historical rows needed reconciliation — everything already matches the current mapping.",
        result,
      });
    }
    const { backfilled } = await addCustomerMapRow({
      actorLoginId: actor(access),
      distributorCode,
      customerCode,
      customerName: body.customerName,
      address: body.address,
      brickId: String(body.brickId ?? "").trim(),
      backfill: true,
    });
    return NextResponse.json({ success: true, message: backfilled > 0 ? `Mapping saved — ${backfilled} historical row(s) healed.` : "Mapping saved." });
  } catch (error) {
    return fail(error, "Failed to save customer mapping.");
  }
}
