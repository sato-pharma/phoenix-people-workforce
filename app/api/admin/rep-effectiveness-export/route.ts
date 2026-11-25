import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { stampPremiumPageNumbers } from "@/lib/hiring-pack/paper-pdf";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import { buildRepEffectivenessDocument } from "@/lib/sales/rep-effectiveness/document";
import { reviewFileName } from "@/lib/sales/rep-effectiveness/model";
import { canExportRepEffectiveness, loadRepEffectiveness } from "@/lib/sales/rep-effectiveness/server";
import { buildRepEffectivenessWorkbook } from "@/lib/sales/rep-effectiveness/workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to twelve closing reads and six KPIs boards, one after another.
export const maxDuration = 300;

const FORBIDDEN = "The effectiveness review is for the Super Admin.";

/**
 * GET /api/admin/rep-effectiveness-export?rep=&from=YYYY-MM&to=YYYY-MM&format=xlsx|pdf — one rep's effectiveness review (owner,
 * 25 Nov 2026: "i want to be able to export from system xlsx and pdf"): the managers' questions answered,
 * KPIs against target, sales against target, the area's history, customers per product per month, every
 * pharmacy by month, and where the growth came from. One report, two renderings — the PDF never runs a
 * second query. The period is the viewer's (owner, 25 Nov 2026: "i want to be able to export per rep in the
 * chosen period"): at most twelve months, never past this month. The Super Admin's alone: asked here before any read, and again in the loader.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!canExportRepEffectiveness(access) || !(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "forbidden", message: FORBIDDEN }, { status: 403 });
    }
    const params = request.nextUrl.searchParams;
    const format = params.get("format") === "pdf" ? "pdf" : "xlsx";
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:rep-effectiveness" });

    const report = await loadRepEffectiveness(access, { hrId: params.get("rep"), from: params.get("from"), to: params.get("to") });
    const fileName = reviewFileName(report.rep.name, report.period, format);

    let body: Uint8Array;
    if (format === "pdf") {
      // `setContent` gives the page no origin, so the premium chrome's `/brand/...` images are inlined first.
      const { html } = inlineLocalAssets(buildRepEffectivenessDocument(report));
      body = await withChromiumPage(async (page) => {
        await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
        await page.emulateMediaType("print");
        await page.evaluate("document.documentElement.setAttribute('data-pm-numbered', '')");
        const bytes = await page.pdf({
          format: "A4",
          landscape: true,
          margin: { bottom: "0", left: "0", right: "0", top: "0" },
          preferCSSPageSize: true,
          printBackground: true,
          timeout: 60_000,
        });
        return stampPremiumPageNumbers(bytes);
      });
    } else {
      body = new Uint8Array(await buildRepEffectivenessWorkbook(report));
    }

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "rep_effectiveness_export",
      entityId: report.rep.hrId,
      summary: `Exported the effectiveness review of ${report.rep.name} as ${format === "pdf" ? "PDF" : "Excel"} (${report.months.length} published months, ${report.pharmacies.length} pharmacies)`,
    });

    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error) || (error instanceof ApiError && error.status === 403)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, FORBIDDEN) }, { status: 403 });
    }
    if (error instanceof ApiError && error.status === 400) {
      return NextResponse.json({ error: error.code, message: clientSafeErrorMessage(error, "Check the rep and the months.") }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "This runtime cannot produce a PDF just now. The Excel file still downloads." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "The effectiveness review could not be made.") }, { status: 500 });
  }
}
