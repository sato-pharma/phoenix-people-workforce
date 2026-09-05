import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  MARKETING_OVERSIGHT_LINE_ROLES,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import {
  closingExportFilterFromQuery,
  loadClosingExportPayload,
} from "@/lib/sales/closing-export-payload";
import {
  CLOSING_PDF_SHEETS,
  REP_CARD_SHEET,
  isClosingPdfSheet,
  renderClosingSheetPdf,
  renderRepCardPdf,
} from "@/lib/sales/closing-report-pdf";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One Monthly Closing page, as a PDF.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A GET, when every other closing export is a POST. Its caller is a hyperlink inside the
 * workbook. A `.xlsx` cannot hold code — the format forbids a VBA part, which is why the macro-free
 * build lost `PhxExportPdf` in the first place — and a hyperlink is the only control it CAN carry.
 * A hyperlink issues a GET from the reader's browser, so the selection travels as query parameters
 * rather than as a JSON body.
 *
 * That also decides the authentication: the click lands in the reader's own browser, carrying their
 * Phoenix session cookie, and the gate below is the same one the premium workbook already passes. A
 * reader who is not signed in gets the sign-in page, not the file — which is the correct answer for
 * a link that may be forwarded with the workbook.
 *
 * ONE SHEET, because that is what the button it replaces did: `PhxExportPdf` exports `ActiveSheet`,
 * never the workbook. Each page carries its own link.
 *
 * WHO MAY CALL IT. Exactly the callers who may take the premium workbook itself — the ones whose
 * sales scope is company-wide. Anything narrower would hand a scoped role the whole company, because
 * neither the closing loader nor the performance review scopes its read to the caller.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-pdf",
    });

    const params = new URL(request.url).searchParams;

    const sheet = (params.get("sheet") ?? "Overview").trim();
    // The Rep Card is the one sheet that is not a table. It draws ONE person, chosen on the sheet by
    // a dropdown, so it needs an area code and is asked for separately -- the link that carries it is
    // a `=HYPERLINK()` FORMULA rather than a shape, because a formula rebuilds its URL when the
    // dropdown changes and a shape's hyperlink is fixed at export time.
    const isRepCard = sheet === REP_CARD_SHEET;
    if (!isRepCard && !isClosingPdfSheet(sheet)) {
      return Response.json(
        {
          error:
            `"${sheet}" is not a page this report can render.`
            + ` Ask for one of: ${[...CLOSING_PDF_SHEETS, REP_CARD_SHEET].join(", ")}.`
            + " The three matrix pages are pivot tables that Excel builds when the workbook opens,"
            + " so the file itself holds no rows for them.",
        },
        { status: 400 },
      );
    }

    const scope = await resolveSalesAccessScope(access);
    if (!scope.canViewAllSales) {
      return Response.json(
        {
          error:
            "This report covers the whole line. Your Monthly Closing export is the one on your own"
            + " closing screen, which is scoped to your areas.",
        },
        { status: 403 },
      );
    }

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
      if (!inScope) {
        return Response.json({ error: "Forbidden: this line is outside your access." }, { status: 403 });
      }
    }

    const payload = await loadClosingExportPayload({
      access,
      filter: closingExportFilterFromQuery(params),
      line: requestedLine || marketingOversight?.line || null,
      period: (params.get("period") ?? "").trim() || null,
    });

    const areaCode = (params.get("area") ?? "").trim();
    if (isRepCard && !areaCode) {
      return Response.json(
        {
          error:
            "The Rep Card covers one area at a time, so this link needs the area it is for."
            + " Pick a rep from the card's own dropdown and use the Export PDF cell on that sheet,"
            + " which carries the choice with it.",
        },
        { status: 400 },
      );
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
      return Response.json({ error: "You do not have permission to export this report." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    // Chromium missing is an infrastructure fact, not a bad request, and it is the one failure a
    // reader can do nothing about — so it says so plainly instead of arriving as "Export failed."
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now. The workbook export is unaffected." },
        { status: 503 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Export failed.") }, { status: 500 });
  }
}
