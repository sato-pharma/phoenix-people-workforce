import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { buildMarketingRequestReportWorkbook } from "@/lib/export/marketing-request-report-workbook";
import { loadMarketingRequestFullReport } from "@/lib/marketing-requests/request-report-service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Downloads the full Marketing Request report as a styled .xlsx.
//
// GET, not POST: it takes no filters and mutates nothing, so a plain link works and the browser's
// own download handling applies. The permission gate is server-side (assertPermission inside the
// loader) — the button that links here is UX only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:marketing:request-report",
    });

    const { generatedAtIso, requests } = await loadMarketingRequestFullReport(access);
    const buffer = await buildMarketingRequestReportWorkbook(requests, {
      exportedByHrId: access.hrId ?? "unknown",
      exportedByName: access.loginId ?? access.hrId ?? "unknown",
      generatedAtIso,
      role: access.role,
    });

    const stamp = generatedAtIso.slice(0, 10);
    return new NextResponse(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="marketing-request-report-${stamp}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      status: 200,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ error: "rate_limited", message: "Too many exports. Try again shortly.", success: false }, { status: 429 });
    }
    const apiError = toApiError(error, "Marketing request report export failed.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
