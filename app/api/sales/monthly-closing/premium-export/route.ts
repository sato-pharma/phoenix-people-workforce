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
import { buildClosingEngineFill, previousPeriod } from "@/lib/sales/closing-engine-data";
import { fillClosingEngine } from "@/lib/sales/closing-engine-fill";
import { closingFileName, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { filterMonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

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
      /** True asks for the .xlsm with the button bar. Default is .xlsx — see below. */
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

    const line = body.line ?? marketingOversight?.line ?? null;
    const period = body.period ?? null;
    const filter = {
      areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
      productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
      regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
      search: typeof body.search === "string" ? body.search : "",
    };

    // The matrix the closing SCREEN renders — store split already applied, then narrowed by the
    // same pure function the table uses. The review is derived from the same source and narrowed
    // the same way, so its rankings describe exactly the areas this matrix kept.
    const [parts, review] = await Promise.all([
      loadMonthlyClosingPartsWithStoreSplit({ line, period }),
      loadClosingPerformanceReview({ filter, line, period }),
    ]);
    const matrix = filterMonthlyClosingMatrix(parts.combined, filter);

    // The month before this one, and every invoice line behind it.
    //
    // The prior month feeds the engine's comparison column and the Rep Card's one-line "<month> was
    // N" — a column the owner built into his own workbook, so it is not optional decoration. Both
    // loads degrade to null rather than failing the export: a month that was never uploaded is a
    // real answer, and the workbook says so in words instead of printing a zero that reads as a
    // collapse in sales.
    //
    // The prior load is checked against what it RETURNED, not against what it was asked for.
    // loadMonthlyClosingParts falls back to the newest available month whenever the period it is
    // given was never uploaded — so asking for a month that does not exist hands back THIS month,
    // and the comparison column would quietly become a copy of itself with every growth figure
    // exactly zero. Compare the period on the matrix and discard anything that is not the month
    // that was asked for.
    const priorPeriod = previousPeriod(matrix.period);
    const [priorParts, details] = await Promise.all([
      priorPeriod
        ? loadMonthlyClosingPartsWithStoreSplit({ line: matrix.line, period: priorPeriod }).catch(() => null)
        : Promise.resolve(null),
      loadMonthlyClosingDetails({
        access,
        // The loader resolves its line by looking the requested one up IN this list, and falls back
        // to `availableLines[0] ?? null` when it is not there. Omit it and the list is empty, the
        // line resolves to null, and the loader returns an empty result WITHOUT THROWING — so the
        // catch below never fires and the Details and Top Customers sheets ship blank behind a
        // perfectly valid workbook. Both other callers pass it for the same reason.
        availableLines: matrix.availableLines,
        availablePeriods: matrix.availablePeriods,
        filters: {
          areaCodes: filter.areaCodes,
          productCodes: filter.productCodes,
          regionCodes: filter.regionCodes,
        },
        line: matrix.line,
        period: matrix.period,
        // Every row the viewer may see, not one page — the Details and Top Customers sheets are the
        // two that answer "which customer", and a page of 200 would answer it for the largest few.
        unpaged: true,
      }).catch(() => null),
    ]);
    const priorMatrix =
      priorParts && priorParts.combined.period === priorPeriod
        ? filterMonthlyClosingMatrix(priorParts.combined, filter)
        : null;

    // The filter stamp, in human names — the standing rule is names, never raw codes. Options come
    // from the UNFILTERED matrix, so every filtered code still resolves to the name it was picked by.
    const nameOf = (list: { code: string; label: string }[], code: string) =>
      list.find((item) => item.code.trim().toUpperCase() === code.trim().toUpperCase())?.label ?? code;
    const noteParts: string[] = [];
    if (filter.regionCodes.length > 0) {
      noteParts.push(`Region: ${filter.regionCodes.map((code) => nameOf(review.filterOptions.regions, code)).join(", ")}`);
    }
    if (filter.areaCodes.length > 0) {
      noteParts.push(`Area: ${filter.areaCodes.map((code) => nameOf(review.filterOptions.areas, code)).join(", ")}`);
    }
    if (filter.productCodes.length > 0) {
      noteParts.push(`Product: ${filter.productCodes.map((code) => nameOf(review.filterOptions.products, code)).join(", ")}`);
    }
    if (filter.search.trim()) noteParts.push(`Area search: "${filter.search.trim()}"`);
    const filterNote =
      noteParts.length === 0
        ? ""
        : `Filtered export — this workbook covers only: ${noteParts.join(" · ")}.`;

    // Fill the OWNER'S engine — never rebuild it. The template is his own .xlsm with its two Excel
    // Tables, three pivots, two slicers, the Rep Card's INDEX/MATCH formulas and the VBA button bar
    // intact; this writes the month's data into the Data sheet and the static pages around it and
    // leaves every other part of the zip byte-identical. Rebuilding the sheets server-side is what
    // shipped on 2026-08-30 and had to be undone: ExcelJS cannot write a pivot table, a slicer or
    // VBA, and that limitation is a reason to stop rebuilding, not a reason to ship without them.
    const macros = body.macros === true;
    const buffer = await fillClosingEngine(
      buildClosingEngineFill({ details: details?.rows ?? null, filterNote, matrix, priorMatrix, review }),
      { macroFree: !macros },
    );
    const fileName = closingFileName({
      extension: macros ? "xlsm" : "xlsx",
      kind: "premium",
      line: matrix.line,
      period: matrix.period,
      region: regionScopeLabel(matrix.regions.map((region) => region.regionName)),
    });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        // .xlsx by default. Everything a reader touches — the pivots, the slicers, the Rep Card
        // dropdown — works without macros; only the four print buttons are VBA, and Excel does both
        // of their jobs natively. A macro-enabled attachment is frequently stripped by mail systems,
        // and Mark-of-the-Web makes Excel refuse the macros outright for anyone who downloaded it.
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
