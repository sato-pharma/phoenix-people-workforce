import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import { makeItHappenErrorResponse } from "@/lib/sales/make-it-happen/api-response";
import {
  buildForecastExportModel,
  buildForecastPdfHtml,
  buildForecastWorkbook,
  forecastExportFilename,
  forecastPdfFooter,
  isForecastExportFormat,
} from "@/lib/sales/make-it-happen/export-document";
import {
  MakeItHappenError,
  requestBody,
  requestedGoalPct,
  requestedRep,
  validatedUnits,
  validatedBricks,
  workspaceFor,
} from "@/lib/sales/make-it-happen/plans";
import { parsePlannerFilters } from "@/lib/sales/make-it-happen/scenarios";
import { canUseMakeItHappen } from "@/lib/sales/make-it-happen/scope";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The forecast on screen, as an Excel workbook or a PDF. POST because the typed units and filters
// travel in the body; it writes nothing. The workspace is rebuilt for the caller before a byte is
// written, so the file can only ever hold what that caller's own planner shows.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!canUseMakeItHappen(access.role)) {
      throw new MakeItHappenError(403, "Make It Happen is not available for your role.");
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:make-it-happen" });

    const body = requestBody(await request.json().catch(() => null));
    const format = body.format;
    if (!isForecastExportFormat(format)) {
      throw new MakeItHappenError(400, "Choose Excel or PDF.");
    }
    const goalPct = requestedGoalPct(body);
    const workspace = await workspaceFor(access, body, requestedRep(body));
    const units = validatedUnits(workspace, body.units);
    const model = buildForecastExportModel({
      workspace,
      units,
      bricks: validatedBricks(workspace, units, body.bricks),
      goalPct,
      filters: parsePlannerFilters(body.filters),
      now: new Date(),
    });
    const filename = forecastExportFilename(model, format);

    if (format === "xlsx") {
      const buffer = await buildForecastWorkbook(model);
      return new NextResponse(buffer as unknown as BodyInit, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    }

    const html = buildForecastPdfHtml(model);
    const pdf = await withChromiumPage(async (page) => {
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.emulateMediaType("print");
      const bytes = await page.pdf({
        displayHeaderFooter: true,
        footerTemplate: forecastPdfFooter(model),
        format: "A4",
        headerTemplate: "<span></span>",
        landscape: true,
        preferCSSPageSize: true,
        printBackground: true,
      });
      return Buffer.from(bytes);
    });
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "The PDF could not be produced right now. The Excel file still works.", success: false },
        { status: 503 },
      );
    }
    return makeItHappenErrorResponse(error, "The forecast could not be exported right now.");
  }
}
