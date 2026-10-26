import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";
import {
  REP_ACHIEVEMENT_ALL,
  filterRepAchievement,
  parseRepAchievementFilters,
} from "@/lib/sales/rep-product-achievement";
import { loadRepProductAchievement } from "@/lib/sales/rep-product-achievement-server";
import { buildRepAchievementWorkbook } from "@/lib/sales/rep-product-achievement-workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The Training Manager's Rep Achievement workbook — the page's own filter (`filterRepAchievement`)
// runs on the same loader, so the file holds exactly the reps she was looking at.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "rep_product_achievement", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:employee-portal:rep-achievement",
    });

    const url = new URL(request.url);
    const filters = parseRepAchievementFilters(url.searchParams);
    const data = await loadRepProductAchievement(url.searchParams.get("semester"));
    const records = filterRepAchievement(data.records, filters);

    const activeFilters: Record<string, string> = {};
    if (filters.line !== REP_ACHIEVEMENT_ALL) {
      activeFilters.Line = data.lines.find((line) => line.value === filters.line)?.label ?? filters.line;
    }
    if (filters.region !== REP_ACHIEVEMENT_ALL) activeFilters.Region = filters.region;
    if (filters.manager !== REP_ACHIEVEMENT_ALL) activeFilters.Manager = filters.manager;
    if (filters.product !== REP_ACHIEVEMENT_ALL) {
      activeFilters.Product =
        records[0]?.products.find((product) => product.productCode === filters.product)?.productName ?? filters.product;
    }
    if (filters.status !== "all") activeFilters.Status = filters.status === "left" ? "Left" : "Active";
    if (filters.search.trim()) activeFilters.Search = filters.search.trim();

    const workbook = await buildRepAchievementWorkbook({ activeFilters, data, records });
    const buffer = await workbook.xlsx.writeBuffer();
    const body = buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer);
    return new NextResponse(body, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="rep-achievement-by-product-${data.semester}.xlsx"`,
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
        { error: "forbidden", message: "You do not have access to export Rep Achievement by Product." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "rep_achievement_export_failed",
        message: clientSafeErrorMessage(error, "Rep Achievement export failed."),
      },
      { status: 500 },
    );
  }
}
