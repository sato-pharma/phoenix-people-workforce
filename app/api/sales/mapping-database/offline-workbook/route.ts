import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { buildOfflineLookupWorkbookBuffer } from "@/lib/sales/offline-lookup-workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ~68,000 customer rows plus the masters and both alias tables, paged 1,000 at a time and then
// written as XLSX. Comfortably inside a minute in practice, but the default 10s would not survive
// a slow read.
export const maxDuration = 60;

// GET — the mapping as an offline workbook: built fresh from live data on every request, never a
// checked-in file. Read-only, persists nothing.
//
// `sales:import`, matching the page this button lives on rather than the weaker `sales:export`
// (which the base Employee and Medical Rep roles both hold). The workbook carries the whole
// customer map nationally — name and address included — so it gets the mapping surface's own gate.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:offline-lookup" });

    const { buffer, stats } = await buildOfflineLookupWorkbookBuffer();
    const stamp = stats.builtAt.slice(0, 10);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        // The build stamp is in the FILENAME as well as on the first sheet. A mapping snapshot that
        // cannot be dated from the file manager is the one that gets mailed around for a month.
        "Content-Disposition": `attachment; filename="sato-brick-area-lookup-${stamp}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Phoenix-Rows": String(stats.customers),
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
    console.error("[sales/mapping-database/offline-workbook] build failed", error);
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Could not build the workbook.") }, { status: 500 });
  }
}
