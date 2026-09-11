import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { lookupCustomerCodeAcrossDistributors, resolveTerritoryText } from "@/lib/sales/mapping-lookup";
import { loadCrosswalks } from "@/lib/sales/normalizer/crosswalks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — the two "I only have half the key" lookups for the Mapping Database screen.
//
//   ?code=<customer code>     which distributor(s) use this code, and does the territory agree
//   ?territory=<free text>    what a district / brick text resolves to, and whether that is safe
//
// Read-only. `sales:read` is what /api/sales/** declares in the access registry, and this handler
// genuinely only reads — it is the lookup, never the write. The write path stays where it is, on
// /api/sales/mapping-database/customer-map, behind sales:import.
//
// Both answers can be a REFUSAL, and that is the point of the feature rather than a shortfall:
// a code used by two distributors that land on different bricks is not resolvable from the code
// alone (544 of them on production), and a territory text with no alias has no other route.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const params = new URL(request.url).searchParams;
    const code = params.get("code")?.trim() ?? "";
    const territory = params.get("territory")?.trim() ?? "";

    if (code) {
      const result = await lookupCustomerCodeAcrossDistributors(code);
      return NextResponse.json({ success: true, kind: "customer_code", result });
    }

    if (territory) {
      // The crosswalks carry both alias tables plus the ambiguous-key set, which is what lets the
      // answer say "ambiguous" instead of "unknown".
      const maps = await loadCrosswalks();
      return NextResponse.json({ success: true, kind: "territory", result: resolveTerritoryText(territory, maps) });
    }

    return NextResponse.json({ success: false, error: "Pass either code or territory." }, { status: 400 });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Lookup failed.") }, { status: 500 });
  }
}
