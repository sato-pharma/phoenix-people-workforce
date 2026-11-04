import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { canExportSosDashboard } from "@/lib/sales/access-scope";
import { buildAndEmailSosBiReport } from "@/lib/sales/sos-report-delivery";
import { isSalesPeriodReleasedCompanyWide } from "@/lib/sales/unpublished-sales-access";
import { loadPublishedPeriodKeys } from "@/lib/sales/vs-target";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual on-demand trigger for the CEO/Super-Admin Source-of-Sales BI email report — same hard
// role gate as the /export route (canExportSosDashboard), so this can never be used to widen
// who receives the confidential workbook. The automatic monthly trigger is a documented TODO in
// app/api/sales/monthly-closing/publish/route.ts, not built yet; this route lets the capability
// be used and tested today.

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canExportSosDashboard(access.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:sos-dashboard-email",
    });

    const body = (await request.json().catch(() => ({}))) as { period?: string };
    const period = String(body.period ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return NextResponse.json({ error: "A period in YYYY-MM format is required." }, { status: 400 });
    }

    // The same line the automatic path holds: once every line has published the month, and not before
    // (owner, 2026-11-04). buildAndEmailSosBiReport reads as the system, so nothing further down asks.
    if (!isSalesPeriodReleasedCompanyWide(period, await loadPublishedPeriodKeys(period, period))) {
      return NextResponse.json({
        reason: "This month's closing is not published on every line yet, so its report cannot be sent.",
        sent: false,
        success: true,
      });
    }

    const result = await buildAndEmailSosBiReport({ period });
    if (!result.sent) {
      return NextResponse.json({ reason: result.reason, sent: false, success: true });
    }
    return NextResponse.json({ recipients: result.recipients.length, sent: true, success: true });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "Failed to send the Source-of-Sales report.") },
      { status: 500 },
    );
  }
}
