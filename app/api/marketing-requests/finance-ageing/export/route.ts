import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage, forbiddenError } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";
import { canViewMarketingFinanceAgeing } from "@/lib/marketing-requests/finance-ageing";
import {
  buildMarketingFinanceAgeingWorkbook,
  marketingFinanceAgeingFilename,
} from "@/lib/marketing-requests/finance-ageing-export";
import { getMarketingFinanceAgeing } from "@/lib/marketing-requests/finance-ageing-service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Excel copy of Finance Ageing. Gated by the page's own role predicate, not by an export
 * permission key: the Finance Manager's `expenses` key is read-only, so a key check would refuse a
 * reader who can see the page, and it would admit others who cannot.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canViewMarketingFinanceAgeing(access.role)) {
      throw forbiddenError("You do not have access to Finance Ageing.");
    }

    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:marketing:finance-ageing",
    });

    const report = await getMarketingFinanceAgeing(access);
    const workbook = await buildMarketingFinanceAgeingWorkbook(report);
    const buffer = await workbook.xlsx.writeBuffer();
    // Requests, requesters and money leave the building, so the fact that the file was taken is recorded.
    await afterResponse("marketing_finance_ageing_export_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: null,
        entityType: "marketing_finance_ageing_export",
        summary: `Exported Finance Ageing (${report.rows.length} requests)`,
      }),
    );
    return new NextResponse(buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer), {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${marketingFinanceAgeingFilename(report.generatedAtIso)}"`,
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
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to Finance Ageing." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "marketing_finance_ageing_export_failed",
        message: clientSafeErrorMessage(error, "The Finance Ageing export failed."),
      },
      { status: 500 },
    );
  }
}
