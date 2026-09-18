import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import { interviewCalendarCaller, listInterviewCalendarWeek } from "@/lib/recruitment/interview-calendar";
import {
  buildInterviewCalendarExportModel,
  buildInterviewCalendarPdfHtml,
  buildInterviewCalendarWorkbook,
  interviewCalendarFilename,
  interviewCalendarPdfFooter,
  isInterviewCalendarExportFormat,
} from "@/lib/recruitment/interview-calendar-export";
import { isDateKey, weekStartFor } from "@/lib/recruitment/interview-calendar-week";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?week=YYYY-MM-DD&format=pdf|xlsx — the week, as a file. Everyone the calendar is shared with
// may export it. Every candidate's name in the file links back to this Phoenix, to that interview
// with its CV open — the origin comes from the trusted-origin list, never from a header as sent, so a
// forged Host cannot put somebody else's address behind the names.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const params = new URL(request.url).searchParams;
    const week = params.get("week") ?? "";
    const format = params.get("format");
    if (!isDateKey(week)) {
      return NextResponse.json({ error: "bad_request", message: "Choose a week to export.", success: false }, { status: 400 });
    }
    if (!isInterviewCalendarExportFormat(format)) {
      return NextResponse.json({ error: "bad_request", message: "Choose PDF or Excel.", success: false }, { status: 400 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:recruitment:interview-calendar" });

    const model = buildInterviewCalendarExportModel({
      ...(await listInterviewCalendarWeek(caller, week)),
      now: new Date(),
      origin: trustedOriginForRedirect(request),
      weekStart: weekStartFor(week),
    });
    const filename = interviewCalendarFilename(model, format);

    if (format === "xlsx") {
      const buffer = await buildInterviewCalendarWorkbook(model);
      return new NextResponse(buffer as unknown as BodyInit, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    }

    const html = buildInterviewCalendarPdfHtml(model);
    const pdf = await withChromiumPage(async (page) => {
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.emulateMediaType("print");
      const bytes = await page.pdf({
        displayHeaderFooter: true,
        footerTemplate: interviewCalendarPdfFooter(model),
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
    return recruitmentApiError(error, "The interview calendar could not be exported right now.");
  }
}
