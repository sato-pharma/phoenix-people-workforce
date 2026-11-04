import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  ConsolidatedClosingSelectionError,
  canExportConsolidatedClosing,
  resolveConsolidatedPeriods,
} from "@/lib/sales/closing-consolidated";
import { buildConsolidatedClosingWorkbook } from "@/lib/sales/monthly-closing-consolidated-export";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import {
  isSalesPeriodReleased,
  loadSalesReleaseKeys,
  readsUnpublishedSalesTools,
} from "@/lib/sales/unpublished-sales-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CONSOLIDATED Monthly Closing workbook — several months of one line added together, as the
 * closing's own workbook. Owner, 2026-09-14: Super Admin and the CEO only.
 *
 * BESIDE /api/sales/monthly-closing/export, which is frozen and untouched. See
 * monthly-closing-consolidated-export.ts for how each month is worked out and added.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    // The role gate is the boundary, not the permission: `sales:export` reaches down to Medical Rep,
    // and every loader behind this reads the whole line company-wide.
    if (!canExportConsolidatedClosing(access.role)) {
      return NextResponse.json(
        { success: false, error: "The consolidated closing is available to the Super Admin and the CEO only." },
        { status: 403 },
      );
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:monthly-closing-consolidated",
    });

    const body = (await request.json().catch(() => ({}))) as {
      areaCodes?: string[];
      line?: string | null;
      periods?: unknown;
      productCodes?: string[];
      regionCodes?: string[];
      search?: string;
    };
    const line = typeof body.line === "string" ? body.line.trim() : "";
    if (!line) {
      return NextResponse.json(
        { success: false, error: "Pick a line to download a consolidated closing." },
        { status: 400 },
      );
    }
    const periods = resolveConsolidatedPeriods(body.periods);
    // A workbook is a file that travels: every month in it must be published (owner, 2026-11-04).
    if (!readsUnpublishedSalesTools(access)) {
      const publishedKeys = await loadSalesReleaseKeys();
      const lineCode = resolveTargetLineCode(line);
      if (!periods.every((period) => isSalesPeriodReleased(period, lineCode, publishedKeys))) {
        return NextResponse.json(
          { success: false, error: "One of these months' closings is not published yet, so this workbook cannot be downloaded." },
          { status: 403 },
        );
      }
    }

    const result = await buildConsolidatedClosingWorkbook({
      access,
      filter: {
        areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
        productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
        regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
        search: typeof body.search === "string" ? body.search : "",
      },
      line,
      periods,
    });
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (error instanceof ConsolidatedClosingSelectionError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to export the consolidated closing.") },
      { status: 500 },
    );
  }
}
