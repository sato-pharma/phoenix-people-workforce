import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { buildMarketingFunctionsWorkbook, marketingFunctionsFileName } from "@/lib/marketing-functions/export";
import { marketingFunctionsErrorResponse, workbookResponse } from "@/lib/marketing-functions/http";
import { resolveMonthKey } from "@/lib/marketing-functions/months";
import { loadMonthSheet } from "@/lib/marketing-functions/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One Product Manager's month as an Excel file, in the Group Product Manager's own layout and colours. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_functions", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:marketing-functions" });

    const url = new URL(request.url);
    const monthKey = resolveMonthKey(url.searchParams.get("month"), todayInCairo());
    const sheet = await loadMonthSheet(access, { authorHrId: url.searchParams.get("author"), monthKey });
    if (!sheet) return NextResponse.json({ message: "Choose a Product Manager first." }, { status: 404 });

    const buffer = await buildMarketingFunctionsWorkbook(sheet);
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: sheet.month?.id ?? `${sheet.authorHrId}:${monthKey}`,
      entityType: "marketing_functions_export",
      summary: `Exported the Monthly Marketing Functions sheet of ${sheet.authorName} for ${monthKey}`,
    });
    return workbookResponse(buffer, marketingFunctionsFileName(sheet));
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to export the month.");
  }
}
