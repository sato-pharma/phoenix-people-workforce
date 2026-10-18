import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { isPortalNsmDsmCycleMonth } from "@/lib/sales/weekly/nsm-dsm-export-months";
import { buildPortalNsmDsmExport } from "@/lib/sales/weekly/portal-nsm-dsm-export";
import { mayDownloadPortalNsmDsmExport } from "@/lib/sales/weekly/portal-weekly-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The NSM/DSM workbook, downloaded by the manager it is about (owner, 2026-10-17). The same builder
// and the same locked design as the admin button — what differs is that the scope comes from the
// SESSION and the only input is `month`. Its own rate-limit scope, so taking this book cannot spend
// the budget of the Depot Detail or Field Force downloads on the same page.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // Re-asked here rather than trusting the flag the page rendered the button from.
    if (!mayDownloadPortalNsmDsmExport(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-portal-nsm-dsm",
    });

    // The ONE input. Nothing else on the query string is read, so no filter on the screen can narrow
    // the book behind the reader's back or collapse its week grid.
    const month = new URL(request.url).searchParams.get("month");
    // A month that is named but unreadable is refused, never replaced by the latest one: that sent
    // November's book to a manager who had asked for October's.
    if (month !== null && month.trim() !== "" && !isPortalNsmDsmCycleMonth(month)) {
      return NextResponse.json(
        { success: false, error: "month must be a cycle month such as 2026-10-01." },
        { status: 400 },
      );
    }
    const { buffer, filename } = await buildPortalNsmDsmExport(access, month);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { success: false, error: "rate_limited", message: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to generate the NSM/DSM export.") },
      { status: 500 },
    );
  }
}
