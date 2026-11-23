import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertOutstationExpenseApprovalReviewAccess } from "@/lib/auth/permissions";
import { isPreviewSession } from "@/lib/auth/preview-session-guard";
import { resolveAccessContext, resolveSessionState } from "@/lib/auth/server";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";
import { logAppError } from "@/lib/error-monitor/service";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { CasePdfError, type CasePdfFailure, renderExpenseCasePdf } from "@/lib/outstation/approvals/case-pdf";
import { CASE_PDF_SETTLED_HEADER, casePdfFilename } from "@/lib/outstation/approvals/case-pdf-plan";
import { deskRouteFailure } from "@/lib/outstation/approvals/route-failure";
import { loadDeskTripFile } from "@/lib/outstation/approvals/trip-file";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A sign-in, the page, the trip's one read, its photos and maps, and the print.
export const maxDuration = 120;

const ROUTE = "/api/admin/outstation/approvals/:requestId/pdf";

const FAILURE_STATUS: Record<CasePdfFailure, number> = { busy: 429, "not-drawn": 502, session: 409, "signed-out": 502, "too-slow": 504 };

/**
 * Expense Approvals — one case as a PDF, looking as it looks on the screen.
 *
 * Owner, 23 Nov 2026: "export every expense trip case as a PDF, looking 100% as it is looking in the
 * system". The PDF is the reviewer screen itself, printed (src/lib/outstation/approvals/case-pdf.ts),
 * not a second drawing of the case.
 *
 * Read only. The gate is the one-trip read's own: whoever may read the desk (Super Admin, CEO) may
 * export a claim on their list, and the PDF shows what THEY see — the page is opened as them, so a
 * reader who is not the approver gets the claim, its checks and the screen's own sentence about the
 * evidence. A claim that is not on the caller's list is 404 before any browser opens. A preview
 * session (the development preview, View as Seat) is refused: the print signs in as a real account.
 */
export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertOutstationExpenseApprovalReviewAccess(access, "expense approvals");

    const requestId = parseOutstationRequestId((await params).requestId);
    if (requestId === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }
    if (isPreviewSession(access)) {
      return NextResponse.json(
        { error: "preview_session", message: "The export needs your own Phoenix sign-in. A preview session cannot make the PDF." },
        { status: 409 },
      );
    }

    // The print signs a browser in as this person, so the sign-in is checked LIVE here. A GET may
    // otherwise stand on the ten-minute saved copy during a login-check outage; a copy never mints a session.
    const live = await resolveSessionState(getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName), { allowRecentCopy: false });
    if (!live?.access.loginId || live.access.loginId !== access.loginId) {
      return NextResponse.json(
        { error: "case_pdf_session", message: "The export needs your own Phoenix sign-in. Sign in again, then export." },
        { status: 409 },
      );
    }
    // Ten exports a minute a person, the limit the desk's two spreadsheet exports share.
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:outstation" });

    // The claim alone, no evidence: is it on this person's list, and what is the file called?
    const file = await loadDeskTripFile(access, requestId, { includeEvidence: false });
    if (!file) {
      return NextResponse.json({ error: "not_found", message: "This claim is not on your list any more." }, { status: 404 });
    }

    const result = await renderExpenseCasePdf(access, requestId);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: String(requestId),
      entityType: "outstation_expense_access",
      summary: `Exported the expense claim of ${file.claim.employeeName} (${file.claim.tripStart}${
        file.claim.tripEnd && file.claim.tripEnd !== file.claim.tripStart ? ` to ${file.claim.tripEnd}` : ""
      }) as a PDF`,
    });

    const filename = casePdfFilename({
      employeeName: file.claim.employeeName,
      requestId,
      tripEnd: file.claim.tripEnd,
      tripStart: file.claim.tripStart,
    });
    return new NextResponse(result.pdf as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/pdf",
        // Whether every photo and map had arrived when it was printed. The button reads this and says
        // so under the bar when it is "no", so a picture that had not arrived is never taken for a missing one.
        [CASE_PDF_SETTLED_HEADER]: result.settled ? "yes" : "no",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ error: "rate_limited", message: error.message }, { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 });
    }
    if (error instanceof CasePdfError) {
      // The person reads the sentence; the cause goes to the app's error table with who it happened to.
      // A refused sign-in and a printer that is taken are answers, not faults.
      if (error.failure !== "session" && error.failure !== "busy") {
        await logAppError({
          source: "server",
          route: ROUTE,
          routeType: "route-handler",
          hrId: access?.hrId ?? null,
          loginId: access?.loginId ?? null,
          role: access?.role ?? null,
          message: `Expense case PDF was not made (${error.failure})${error.reason ? `: ${error.reason}` : ""}`,
          stack: error.stack ?? null,
        }).catch(() => {
          // The logger never turns a failing answer into a crash.
        });
      }
      return NextResponse.json({ error: `case_pdf_${error.failure.replace(/-/g, "_")}`, message: error.message }, { status: FAILURE_STATUS[error.failure] });
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "The PDF printer is busy or not available right now. Try again in a minute." },
        { status: 503 },
      );
    }
    return deskRouteFailure({ access, code: "expense_case_pdf_failed", error, fallback: "Unable to make the PDF.", route: ROUTE });
  }
}
