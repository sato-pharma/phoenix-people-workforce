import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMonthlyClosingComparison } from "@/lib/sales/monthly-closing-comparison";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { buildClosingDetailsWorkbook, buildMonthlyClosingWorkbook } from "@/lib/sales/monthly-closing-export";
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
  loadMonthlyClosing,
} from "@/lib/sales/monthly-distributor-import";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slug(value: string | null | undefined) {
  return (value ?? "all").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "all";
}

function fileResponse(buffer: Buffer, fileName: string) {
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:monthly-closing" });

    const body = (await request.json().catch(() => ({}))) as {
      includeConfidential?: boolean;
      line?: string | null;
      period?: string | null;
    };

    // Only the admin account gets the full 6-sheet workbook (Matrix, Distributor Comparison,
    // Rankings, Gaps, Summary, plus the Data/Total audit pair). loadMonthlyClosing and
    // loadMonthlyClosingComparison are UNSCOPED, company-wide reads with no region/product
    // narrowing — exactly the same admin-only gate this route always had, unchanged.
    if (access.role === "Super Admin" || access.scope === "system") {
      // Server-load the full report (matrix + distributor comparison + insights). The body is
      // only the line/period selection — never trusted for data or authorization.
      const matrix = await loadMonthlyClosing({ line: body.line ?? null, period: body.period ?? null });
      const comparison = await loadMonthlyClosingComparison(matrix.line, matrix.period);

      // Raw invoice lines behind the closing, for the visible Data + Total audit sheets. Unpaged —
      // the workbook needs every row. Scope and the confidential gate are enforced inside the
      // service against this caller, so the export can never widen what they may see.
      const details = await loadMonthlyClosingDetails({
        access,
        line: matrix.line,
        period: matrix.period,
        availableLines: matrix.availableLines,
        availablePeriods: matrix.availablePeriods,
        includeConfidential: body.includeConfidential === true,
        unpaged: true,
      });

      const buffer = await buildMonthlyClosingWorkbook(matrix, comparison, details);
      return fileResponse(buffer, `phoenix-monthly-closing-${slug(matrix.line)}-${slug(matrix.period)}.xlsx`);
    }

    // Every other role that can reach the Details tab (sales:export is granted on every scoped
    // sales role — District/Regional/National Sales Manager, Product/Group Product Manager, and
    // any other "sales: read" role) can export exactly what that tab shows them: the raw rows
    // already scoped by loadMonthlyClosingDetails (line, region, per-user product allowlist,
    // confidential lock). No Matrix/Comparison sheets — those loaders are unscoped and would
    // leak data outside this caller's access if included here.
    const [availableLines, availablePeriods] = await Promise.all([
      listMonthlyClosingLines(),
      listMonthlyClosingPeriods(),
    ]);
    const details = await loadMonthlyClosingDetails({
      access,
      line: body.line ?? null,
      period: body.period ?? null,
      availableLines,
      availablePeriods,
      includeConfidential: body.includeConfidential === true,
      unpaged: true,
    });

    if (details.outOfScope) {
      return NextResponse.json(
        { success: false, error: "Forbidden: this line is outside your access." },
        { status: 403 },
      );
    }
    if (!details.line || !details.period) {
      return NextResponse.json(
        { success: false, error: "No validated Monthly Closing data available to export." },
        { status: 400 },
      );
    }

    const buffer = await buildClosingDetailsWorkbook(details);
    return fileResponse(buffer, `phoenix-monthly-closing-details-${slug(details.line)}-${slug(details.period)}.xlsx`);
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export Monthly Closing." },
      { status: 500 },
    );
  }
}
