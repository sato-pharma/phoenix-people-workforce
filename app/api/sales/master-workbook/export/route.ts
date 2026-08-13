import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertPermission } from "@/lib/auth/permissions";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { buildMasterWorkbookBuffer } from "@/lib/sales/master-workbook";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The workbook can be large (tens of thousands of rows across the detail sheets); allow headroom.
export const maxDuration = 60;

// Read-only: builds the full 17-sheet master workbook from LIVE system data and streams it as XLSX.
// Persists nothing. Reflects the current masters, aliases, customers, and imported sales every call.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Mirrors the page gate (app/(admin)/sales/database-mapping/page.tsx) -- Super Admin / system
    // only. `sales:export` alone is NOT sufficient here: the base Employee and Medical Rep roles
    // both hold it (see permissions.ts), and this workbook is company-wide with no access-scope
    // narrowing at all -- Raw_Sales carries every validated invoice row nationally, with customer
    // name, address, quantity and net EGP. The page was Super-Admin-gated while this route, which
    // is reachable directly, was not.
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: the master workbook export is restricted to Super Admin." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:master-workbook" });

    // Confidential products (LA003 / LA004) are included in the export only for CEO / Super Admin.
    const buffer = await buildMasterWorkbookBuffer({
      includeRestricted: canViewRestrictedProducts(access.role),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `phoenix-master-workbook-${stamp}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
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
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    // The prior lack of any server-side log meant a real 500 here was only ever visible in the
    // browser network tab, never in Cloud Run logs — log it so future failures are diagnosable.
    console.error("[sales/master-workbook/export] failed:", error);
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Export failed.") }, { status: 500 });
  }
}
