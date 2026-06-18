import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { addCustomerMapRow } from "@/lib/sales/normalizer/customer-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH = 500;

type AcceptMapping = {
  address?: string;
  brickId?: string;
  customerCode?: string;
  customerName?: string;
  distributorCode?: string;
};

// Accept one or more suggested customer→brick mappings from the preview modal. Each accepted row is
// written to the customer mapping sheet (the source of truth) via the audited addCustomerMapRow, so a
// confirmed suggestion resolves that customer on every future import. Partial success is reported
// per-row — one bad row never rolls back the good ones.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const body = (await request.json().catch(() => ({}))) as { mappings?: AcceptMapping[] };
    const mappings = Array.isArray(body.mappings) ? body.mappings.slice(0, MAX_BATCH) : [];
    if (mappings.length === 0) {
      return NextResponse.json({ error: "No mappings to accept.", success: false }, { status: 400 });
    }

    // Each result carries distributorCode so the client can reconcile by the composite
    // (distributorCode|customerCode) identity — the same customerCode can appear under two distributors.
    const results: { customerCode: string; distributorCode: string; error?: string; ok: boolean }[] = [];
    let accepted = 0;
    for (const mapping of mappings) {
      const distributorCode = String(mapping.distributorCode ?? "").trim();
      const customerCode = String(mapping.customerCode ?? "").trim();
      const brickId = String(mapping.brickId ?? "").trim();
      if (!distributorCode || !customerCode || !brickId) {
        results.push({ customerCode, distributorCode, error: "Distributor, customer code, and brick are required.", ok: false });
        continue;
      }
      try {
        await addCustomerMapRow({
          actorLoginId,
          address: String(mapping.address ?? "").trim(),
          brickId,
          customerCode,
          customerName: String(mapping.customerName ?? "").trim(),
          distributorCode,
        });
        accepted += 1;
        results.push({ customerCode, distributorCode, ok: true });
      } catch (error) {
        results.push({ customerCode, distributorCode, error: error instanceof Error ? error.message : "Failed to map this customer.", ok: false });
      }
    }

    return NextResponse.json({
      data: { accepted, failed: mappings.length - accepted, results },
      message: `${accepted} of ${mappings.length} mapping${mappings.length === 1 ? "" : "s"} added.`,
      success: accepted > 0,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden.", success: false }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ code: error.code, error: error.message, success: false }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to accept mappings.", success: false }, { status: 500 });
  }
}
