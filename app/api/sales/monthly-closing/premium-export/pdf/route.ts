import { NextResponse } from "next/server";

import { isUnauthenticatedAccess } from "@/lib/auth/api-session-response";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { trustedOriginForRedirect } from "@/lib/security/origins";
import {
  MARKETING_OVERSIGHT_LINE_ROLES,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import {
  closingExportFilterFromQuery,
  loadClosingExportPayload,
  type ClosingExportPayload,
} from "@/lib/sales/closing-export-payload";
import { sealedPdfRequest, sealedReaderAccess } from "@/lib/sales/closing-pdf-link-seal";
import {
  CLOSING_PDF_SHEETS,
  REP_CARD_SHEET,
  isClosingPdfSheet,
  renderClosingSheetPdf,
  renderRepCardPdf,
} from "@/lib/sales/closing-report-pdf";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleased, readsUnpublishedSalesTools } from "@/lib/sales/unpublished-sales-access";
import { loadPublishedPeriodKeys } from "@/lib/sales/vs-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One Monthly Closing page, as a PDF.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A GET, when every other closing export is a POST. Its caller is a hyperlink inside the
 * workbook. A `.xlsx` cannot hold code — the format forbids a VBA part, which is why the macro-free
 * build lost `PhxExportPdf` in the first place — and a hyperlink is the only control it CAN carry.
 * A hyperlink issues a GET from the reader's browser, so the selection travels in the URL rather than
 * as a JSON body.
 *
 * ONE SHEET, because that is what the button it replaces did: `PhxExportPdf` exports `ActiveSheet`,
 * never the workbook. Each page carries its own link.
 *
 * WHO MAY CALL IT — owner, 2026-09-14: "any one who receive the closing can export".
 *
 *   - A SEALED link (every workbook downloaded since that date) is served to whoever holds the file,
 *     signed in or not. The line, month and filters are read OUT OF THE SEAL, never off the query
 *     string, so editing the URL cannot reach anything the file does not already hold; the detail
 *     rows load as `sealedReaderAccess`, which keeps El Qema masked for everyone but the Super Admin.
 *     See `closing-pdf-link-seal.ts`.
 *   - An UNSEALED link — a workbook downloaded before seals existed — keeps the gate it always had:
 *     only callers whose sales scope is company-wide, because neither the closing loader nor the
 *     performance review scopes its read to the caller, and without a seal the query string is all
 *     there is. A signed-out reader is sent to sign in and back, rather than told he has no
 *     permission; a signed-in reader outside that gate is told to ask for a fresh copy, which is sealed.
 *
 * Refusals are a readable page when a browser asks, because the person reading one clicked a link in
 * Excel and would otherwise be looking at raw JSON.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const params = new URL(request.url).searchParams;
    const sealed = sealedPdfRequest(params);

    if (!sealed) {
      if (isUnauthenticatedAccess(access)) return signInRedirect(request);
      await assertPermission(access, "sales", "export");
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-pdf",
    });

    const sheet = sealed ? sealed.sheet : (params.get("sheet") ?? "Overview").trim();
    // The Rep Card is the one sheet that is not a table. It draws ONE person, chosen on the sheet by
    // a dropdown, so it needs an area code and is asked for separately -- the link that carries it is
    // a `=HYPERLINK()` FORMULA rather than a shape, because a formula rebuilds its URL when the
    // dropdown changes and a shape's hyperlink is fixed at export time.
    const isRepCard = sheet === REP_CARD_SHEET;
    if (!isRepCard && !isClosingPdfSheet(sheet)) {
      return refusal(
        request,
        400,
        `"${sheet}" is not a page this report can render.`
          + ` Ask for one of: ${[...CLOSING_PDF_SHEETS, REP_CARD_SHEET].join(", ")}.`
          + " The three matrix pages are pivot tables that Excel builds when the workbook opens,"
          + " so the file itself holds no rows for them.",
      );
    }

    const areaCode = sealed ? sealed.cardArea : (params.get("area") ?? "").trim();
    if (isRepCard && !areaCode) {
      return refusal(
        request,
        400,
        "The Rep Card covers one area at a time, so this link needs the area it is for."
          + " Pick a rep from the card's own dropdown and use the Export PDF cell on that sheet,"
          + " which carries the choice with it.",
      );
    }

    let payload: ClosingExportPayload;
    if (sealed) {
      // The Rep Card is drawn from the SEALED selection, not narrowed to the requested area: an area
      // the file does not hold then finds no row and renders "No area matches", instead of a card
      // for a rep the reader was never sent.
      payload = await loadClosingExportPayload({
        access: sealedReaderAccess(sealed.selection, access),
        filter: sealed.selection.filter,
        line: sealed.selection.line,
        period: sealed.selection.period,
      });
    } else {
      const scope = await resolveSalesAccessScope(access);
      if (!scope.canViewAllSales) return refusal(request, 403, FRESH_COPY);

      // The Marketing Manager holds company sales scope but oversees only some lines, so she is
      // admitted for a line she actually oversees and refused for any other — never quietly handed a
      // different line's figures under the heading she asked for.
      const marketingOversight = MARKETING_OVERSIGHT_LINE_ROLES.has(access.role)
        ? await resolvePortalClosingScope(access)
        : null;
      const requestedLine = (params.get("line") ?? "").trim();
      if (marketingOversight && requestedLine) {
        const inScope = marketingOversight.allowedLines.some(
          (candidate) => normalizeLineKey(candidate) === normalizeLineKey(requestedLine),
        );
        if (!inScope) return refusal(request, 403, "This line is outside your access.");
      }

      payload = await loadClosingExportPayload({
        access,
        filter: closingExportFilterFromQuery(params),
        line: requestedLine || marketingOversight?.line || null,
        period: (params.get("period") ?? "").trim() || null,
      });

      // The same refusal as the workbook beside it: a PDF is a file that travels (owner, 2026-11-04).
      // Asked of the month and line the payload RESOLVED, since both may arrive empty. A sealed link
      // is not asked: it holds what its workbook already holds.
      if (
        !readsUnpublishedSalesTools(access)
        && payload.period
        && !isSalesPeriodReleased(
          payload.period,
          resolveTargetLineCode(payload.line),
          await loadPublishedPeriodKeys(payload.period, payload.period),
        )
      ) {
        return refusal(request, 403, "This month's closing is not published yet, so its PDF cannot be downloaded.");
      }
    }

    const pdf = isRepCard
      ? await renderRepCardPdf({ areaCode, fill: payload.fill, line: payload.line, period: payload.period })
      : await renderClosingSheetPdf({
          fill: payload.fill,
          line: payload.line,
          period: payload.period,
          sheet,
        });

    // A stable, readable filename: the reader saves several of these in a month and sorts them by
    // name. Codes never appear in one — the standing rule is human-readable names everywhere.
    // Both parts are nullable: a line with nothing uploaded resolves to no line and no month. The
    // file still needs a name, so each falls back to a word rather than to the string "null".
    const safe = (value: string | null, fallback: string) =>
      (value?.trim() ? value : fallback).replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    const fileName =
      `phoenix-closing-${safe(payload.line, "all-lines")}`
      + `-${safe(payload.period, "no-month")}-${safe(sheet, "sheet")}`
      + `${isRepCard ? `-${safe(areaCode, "area")}` : ""}.pdf`;

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return refusal(request, 403, FRESH_COPY);
    }
    if (isApiRateLimitError(error)) {
      return refusal(request, 429, error.message);
    }
    // Chromium missing is an infrastructure fact, not a bad request, and it is the one failure a
    // reader can do nothing about — so it says so plainly instead of arriving as "Export failed."
    if (error instanceof ChromiumUnavailableError) {
      return refusal(request, 503, "This server cannot render PDFs right now. The workbook itself is unaffected.");
    }
    return refusal(request, 500, clientSafeErrorMessage(error, "Export failed."));
  }
}

/**
 * The answer to a signed-in reader holding an UNSEALED link he is not allowed to open. It is not a
 * permissions problem he can fix, and nothing about his role should change: the file was downloaded
 * before its links were sealed, and a fresh download is sealed.
 */
const FRESH_COPY =
  "This copy of the closing workbook was downloaded before its Export PDF links could be opened by"
  + " everyone who receives it. Ask for a fresh download of the closing, and the Export PDF links in"
  + " the new copy will work for you.";

/**
 * Sign in, then straight back to this PDF. The login page already honours a same-origin `returnUrl`.
 *
 * The origin is the PUBLIC one, never `request.url`'s: behind Railway's proxy that is the container's
 * own bind address (`https://0.0.0.0:8080`), which is the exact bug the workbook's links first shipped
 * with — see the note in the workbook export route.
 */
function signInRedirect(request: Request): Response {
  const { pathname, search } = new URL(request.url);
  const login = new URL("/login", trustedOriginForRedirect(request));
  login.searchParams.set("returnUrl", `${pathname}${search}`);
  const response = NextResponse.redirect(login);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A refusal: a short readable page for a browser, the usual `{ error }` body for anything else. */
function refusal(request: Request, status: number, message: string): Response {
  if (!(request.headers.get("accept") ?? "").includes("text/html")) {
    return Response.json({ error: message }, { status });
  }
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monthly Closing PDF</title>
<style>
body{margin:0;padding:48px 16px;background:#f6f5f2;color:#1c1c1c;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #d9d6cf;border-top:3px solid #f26a21;padding:24px}
h1{margin:0 0 10px;font-size:18px}
p{margin:0}
</style></head>
<body><main><h1>This PDF could not be created</h1><p>${escapeText(message)}</p></main></body></html>`;
  return new Response(page, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
    status,
  });
}
