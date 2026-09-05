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
import { fillClosingEngine } from "@/lib/sales/closing-engine-fill";
import { closingFileName, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import { loadClosingExportPayload } from "@/lib/sales/closing-export-payload";
import { buildReviewSheets } from "@/lib/sales/closing-review-sheets";
import { isClosingPdfSheet } from "@/lib/sales/closing-report-pdf";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The PREMIUM Monthly Closing workbook — the second Export button on the closing screen.
 *
 * It sits BESIDE /api/sales/monthly-closing/export and replaces nothing. The owner's instruction
 * (2026-08-30) was that both files stay available and the reader picks the one they read more
 * comfortably: the existing workbook is the auditor's file — distributor comparison, store split,
 * channel tabs and the invoice-row Data/Total pair — and this one is the reader's file.
 *
 * What it returns is the owner's OWN workbook, filled. Twelve sheets, two Excel Tables behind a
 * hidden Data sheet, three pivot tables that grow with those tables, two region slicers, a Rep Card
 * that recomputes every product for whoever is picked from its dropdown, and the VBA button bar.
 * None of that is rebuilt here — the template IS his engine and this route writes a month into it.
 *
 * Both routes are fed by the SAME loaders at the SAME line, month and filter, so the two workbooks
 * and the screen cannot show different numbers. Nothing about the sheets' CONTENT arrives from the
 * browser; only which selection to read.
 *
 * WHO MAY CALL IT. Exactly the callers who already receive the FULL workbook from the existing
 * route: the ones whose sales scope is company-wide. That set is Super Admin, system scope, SFE
 * Manager, CEO, Finance Manager and the Marketing Manager (whose persisted sales_scope_override is
 * COMPANY), and it is asked as a question about scope rather than copied as a list of role names —
 * the existing route spells the same set out inline because a test pins that line's literal text.
 *
 * The gate matters because `sales:export` reaches down to Medical Rep, and neither the closing
 * matrix loader nor the performance review scopes its read to the caller. A bare permission check
 * would therefore hand a scoped sales role the whole company. Scoped roles keep the export they
 * already have on the portal screen, which is built for them.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-premium",
    });

    const body = (await request.json().catch(() => ({}))) as {
      areaCodes?: string[];
      line?: string | null;
      /** False asks for the button-less plain .xlsx. Default is the .xlsm — see below. */
      macros?: boolean;
      period?: string | null;
      productCodes?: string[];
      regionCodes?: string[];
      search?: string;
    };

    const scope = await resolveSalesAccessScope(access);
    if (!scope.canViewAllSales) {
      return Response.json(
        {
          error:
            "This workbook covers the whole line. Your Monthly Closing export is the one on your own"
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
    if (marketingOversight) {
      const requestedLine = String(body.line ?? "").trim();
      const inScope = marketingOversight.allowedLines.some(
        (candidate) => normalizeLineKey(candidate) === normalizeLineKey(requestedLine),
      );
      if (requestedLine && !inScope) {
        return Response.json({ error: "Forbidden: this line is outside your access." }, { status: 403 });
      }
    }

    // Loaded by the shared module, not inline. The PDF renderer is the third reader of this same
    // month, and every branch of the load is a wrong NUMBER rather than an error when it is got
    // wrong -- a prior matrix for the wrong month, a details loader silently handed no line. Three
    // copies is where those drift; see `closing-export-payload.ts` for the traps it carries.
    const payload = await loadClosingExportPayload({
      access,
      filter: {
        areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
        productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
        regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
        search: typeof body.search === "string" ? body.search : "",
      },
      line: body.line ?? marketingOversight?.line ?? null,
      period: body.period ?? null,
    });

    // Fill the OWNER'S engine — never rebuild it. The template is his own .xlsm with its two Excel
    // Tables, three pivots, two slicers, the Rep Card's INDEX/MATCH formulas and the VBA button bar
    // intact; this writes the month's data into the Data sheet and the static pages around it and
    // leaves every other part of the zip byte-identical. Rebuilding the sheets server-side is what
    // shipped on 2026-08-30 and had to be undone: ExcelJS cannot write a pivot table, a slicer or
    // VBA, and that limitation is a reason to stop rebuilding, not a reason to ship without them.
    // .xlsm with the button bar is the DEFAULT, by the owner's explicit instruction on 2026-09-02:
    // "I want the buttons ... the export as PDF must be in this sheet ... I don't want to lose a
    // single feature." A .xlsx cannot carry code at all, so a button in one cannot RUN anything —
    // but it can LINK. Passing `macros: false` builds the plain .xlsx, and since 2026-09-05 that
    // build keeps Export PDF as a hyperlink to the renderer below; the remaining buttons, whose work
    // Excel already does natively, are removed rather than shipped as shortcuts that answer a click
    // with "Cannot run the macro 'PhxExportPdf'".
    const macros = body.macros !== false;

    // The macro-free build gets its Export PDF button back as a hyperlink. The origin is the one the
    // reader is actually on, not a configured constant — a workbook taken from staging must not send
    // its reader to production, which is a difference nobody would notice until the numbers on the
    // PDF disagreed with the numbers in their hands.
    const origin =
      new URL(request.url).origin
      || (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
    const pdfLink = (sheet: string): string | null => {
      if (!isClosingPdfSheet(sheet)) return null;
      // Only what actually resolved. An empty `line=` would narrow the PDF to a line named by the
      // empty string, which matches nothing and renders as a page with no rows rather than an error;
      // omitted, the route resolves the same default the workbook did.
      const query = new URLSearchParams({ sheet });
      if (payload.line) query.set("line", payload.line);
      if (payload.period) query.set("period", payload.period);
      for (const code of body.regionCodes ?? []) query.append("region", code);
      for (const code of body.areaCodes ?? []) query.append("area", code);
      for (const code of body.productCodes ?? []) query.append("product", code);
      if (typeof body.search === "string" && body.search.trim()) query.set("search", body.search.trim());
      return `${origin}/api/sales/monthly-closing/premium-export/pdf?${query.toString()}`;
    };

    // The Rep Card's link is a FORMULA, not a shape: the sheet draws whichever rep its dropdown is
    // set to, and only a formula can append that choice to the URL when the sheet recalculates.
    const repCardPdfBase = `${origin}/api/sales/monthly-closing/premium-export/pdf?${new URLSearchParams({
      ...(payload.line ? { line: payload.line } : {}),
      ...(payload.period ? { period: payload.period } : {}),
      sheet: "Rep Card",
    }).toString()}`;

    // The Performance Review folded in as extra sheets, at the owner's instruction (2026-09-05):
    // one workbook instead of two. Only what the engine does not already carry -- the review's own
    // Rep Ranking and Family Performance would collide with the sheets of those names already here.
    const reviewSheets = buildReviewSheets(payload.review, { line: payload.line, period: payload.period });

    const buffer = await fillClosingEngine(payload.fill, {
      macroFree: !macros,
      reviewSheets,
      ...(macros ? {} : { pdfLink, repCardPdfBase }),
    });
    const fileName = closingFileName({
      extension: macros ? "xlsm" : "xlsx",
      kind: "premium",
      line: payload.line,
      period: payload.period,
      region: regionScopeLabel(payload.matrix.regions.map((region) => region.regionName)),
    });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        // .xlsm by default, so the button bar the owner built is live: Export PDF, Refresh,
        // Expand/Collapse all, Reset filters and the region buttons — 36 shapes across 11 drawings,
        // all six routines present in vbaProject.bin.
        //
        // A reader who never touches a button loses nothing in the .xlsx either — the pivots, the
        // slicers and the Rep Card dropdown are all native. But Export PDF has NO macro-free
        // equivalent inside the workbook, and .xlsx is a format with no code in it, so a button
        // there cannot be made to work. That is why the buttons are the reason for the extension
        // and not the other way round.
        //
        // The cost is real and is the owner's call, made knowingly: mail systems strip .xlsm
        // attachments, and Mark-of-the-Web makes Excel show "SECURITY RISK ... blocked macros" for
        // anyone who downloads one. A Trusted Location on the reader's machine is what removes that
        // bar for good — signing the project alone does NOT, because the MOTW block is applied
        // before publisher trust is consulted.
        //
        // Neither the buttons nor the extension is what made Excel offer to repair the file — that
        // was the pivot cache, see restorePivotCacheSharedItems. Separate defects, found in that
        // order.
        "Content-Type": macros
          ? "application/vnd.ms-excel.sheet.macroEnabled.12"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "You do not have permission to export this report." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Export failed.") }, { status: 500 });
  }
}
