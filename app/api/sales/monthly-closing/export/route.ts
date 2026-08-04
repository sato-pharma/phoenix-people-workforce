import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  loadMonthlyClosingComparison,
  loadMonthlyClosingComparisonFromRows,
} from "@/lib/sales/monthly-closing-comparison";
import { type ClosingDetailsFilters, loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { buildClosingDetailsWorkbook, buildMonthlyClosingWorkbook } from "@/lib/sales/monthly-closing-export";
import {
  filterMonthlyClosingMatrix,
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
  loadMonthlyClosing,
  rebuildMatrixFromRows,
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
      areaCodes?: string[];
      detailSearch?: string;
      distributorCodes?: string[];
      inclusion?: string;
      includeConfidential?: boolean;
      line?: string | null;
      period?: string | null;
      productCodes?: string[];
      regionCodes?: string[];
      search?: string;
    };

    // The on-screen matrix filter, applied server-side with the SAME pure function the table uses
    // (filterMonthlyClosingMatrix) so the workbook and the screen cannot diverge. It narrows only —
    // what the caller is allowed to see is still decided by the loaders below.
    const matrixFilter = {
      areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
      productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
      regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
      search: typeof body.search === "string" ? body.search : "",
    };

    // Row-level filters for the Data/Total sheets. The three shared code lists narrow every sheet
    // in the book; distributor and Included/Excluded are row-level only, because an area x product
    // matrix has no distributor dimension and no excluded bucket to slice.
    //
    // The two search boxes are deliberately separate fields: the matrix search matches an area's
    // code or name, while the Details tab's box also matches customer, brick and product text.
    // Feeding a customer-name search into the matrix filter would match no area at all and blank
    // the Matrix sheet, so the Details text arrives as `detailSearch` and stays on the rows.
    const distributorCodes = Array.isArray(body.distributorCodes) ? body.distributorCodes : [];
    const inclusion = typeof body.inclusion === "string" ? body.inclusion : "";
    const detailSearch = typeof body.detailSearch === "string" ? body.detailSearch : "";
    const detailFilters: ClosingDetailsFilters = {
      areaCodes: matrixFilter.areaCodes,
      distributorCodes,
      inclusion,
      productCodes: matrixFilter.productCodes,
      regionCodes: matrixFilter.regionCodes,
      search: detailSearch,
    };

    // Row-level filters slice INSIDE an area x product cell, which the aggregate RPCs cannot
    // express. When one is active, the matrix and the comparison are REBUILT from the exact
    // invoice rows the Data sheet will show — so every sheet in the workbook, including the
    // matrix sheet's live formulas over the hidden Calc sheet, covers the same slice and the
    // Total sheet's tie to the matrix holds by construction.
    const rowLevelActive = distributorCodes.length > 0 || inclusion.trim() !== "" || detailSearch.trim() !== "";
    // A product filter alone keeps the RPC matrix (targets stay meaningful), but the comparison
    // still comes from rows: the brick/customer aggregates carry no product code, so only a
    // from-rows comparison can slice the customer and brick rankings by product.
    const comparisonFromRows = rowLevelActive || matrixFilter.productCodes.length > 0;

    // Only the admin account gets the full 6-sheet workbook (Matrix, Distributor Comparison,
    // Rankings, Gaps, Summary, plus the Data/Total audit pair). loadMonthlyClosing and
    // loadMonthlyClosingComparison read company-wide and take no account of WHO is asking — the
    // scope passed below is the reader's on-screen filter, a convenience, never a permission
    // boundary. That is why this stays behind exactly the same admin-only gate it always had.
    if (access.role === "Super Admin" || access.scope === "system") {
      // Server-load the full report (matrix + distributor comparison + insights). The body is
      // only the line/period selection — never trusted for data or authorization.
      const fullMatrix = await loadMonthlyClosing({ line: body.line ?? null, period: body.period ?? null });
      const matrix = filterMonthlyClosingMatrix(fullMatrix, matrixFilter);

      // Scope every other sheet to the areas the filtered matrix actually KEPT, rather than
      // re-applying the raw filter to each one. That is what makes the sheets agree: the matrix
      // search matches an area's code or name, so resolving region + area + search down to a
      // concrete area list here means Data, Total and the comparison sheets can never hold a row
      // from an area the Matrix sheet dropped.
      //
      // Products are deliberately NOT derived the same way. The matrix has no column for a
      // confidential product, so using its columns as a product filter would strip the very rows
      // the opt-in "Confidential" sheet exists to show. The explicit product list is used instead,
      // and an empty one keeps meaning "every product".
      const placeNarrowed = matrixFilter.regionCodes.length > 0
        || matrixFilter.areaCodes.length > 0
        || matrixFilter.search.trim().length > 0;
      const keptAreaCodes = matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode));
      // A narrowing filter that matched no area must yield no rows. An empty list reads as "no
      // filter" downstream, so stand in a code no area can have.
      const scopedAreaCodes = placeNarrowed
        ? (keptAreaCodes.length > 0 ? keptAreaCodes : ["__NO_MATCHING_AREA__"])
        : [];

      // Raw invoice lines behind the closing, for the visible Data + Total audit sheets — and,
      // under row-level filters, the source every other sheet is rebuilt from. Unpaged — the
      // workbook needs every row. Scope and the confidential gate are enforced inside the
      // service against this caller, so the export can never widen what they may see.
      // These two reads dominate the export — measured on July 2026 Pedia, 7.4s and 7.8s of a
      // 17.3s total, against 1.3s to actually build the workbook. They were issued one after the
      // other, so the caller waited for their SUM.
      //
      // Only the from-rows comparison needs `details.rows`; the aggregate one reads its own
      // leaves and shares nothing but the line/period/area scope. So when the from-rows variant
      // is not in play, both are STARTED before either is awaited and the wait becomes the slower
      // of the two rather than the total. Same queries, same results, same order of arguments —
      // purely a matter of not blocking on the first before asking for the second.
      const detailsPromise = loadMonthlyClosingDetails({
        access,
        line: matrix.line,
        period: matrix.period,
        availableLines: matrix.availableLines,
        availablePeriods: matrix.availablePeriods,
        // Region is subsumed by the resolved area list, so it is cleared to keep one source of
        // place narrowing rather than two that could disagree.
        filters: { ...detailFilters, areaCodes: scopedAreaCodes, regionCodes: [] },
        includeConfidential: body.includeConfidential === true,
        unpaged: true,
      });
      // Started here, awaited below. Null when the comparison must be rebuilt from the detail
      // rows, which cannot begin until those rows exist.
      const aggregateComparisonPromise = comparisonFromRows
        ? null
        : loadMonthlyClosingComparison(matrix.line, matrix.period, { areaCodes: scopedAreaCodes });
      // An in-flight promise whose rejection is never awaited is an UNHANDLED rejection, which can
      // take the process down. If the details read below throws first we leave this scope without
      // ever awaiting this one, so park a no-op handler now. The real `await` still surfaces the
      // error normally — attaching a catch does not swallow it for the awaiting caller.
      aggregateComparisonPromise?.catch(() => {});

      const details = await detailsPromise;
      const comparison = aggregateComparisonPromise
        ? await aggregateComparisonPromise
        : await loadMonthlyClosingComparisonFromRows(
          matrix.line,
          matrix.period,
          details.rows,
          // Masters still narrow to the filtered place so white-space denominators stay honest;
          // the leaves are already exactly the filtered rows.
          { areaCodes: scopedAreaCodes },
        );

      // Under a row-level filter the aggregate matrix cannot express the slice — rebuild its
      // cells from the same rows, so sheet 1 and the audit pair describe one population.
      const workbookMatrix = rowLevelActive ? rebuildMatrixFromRows(matrix, details.rows) : matrix;

      // The filter stamp, in human names (standing rule: names, never raw codes). Options lists
      // come from the caller's own scope, so every filterable code resolves; a code that matched
      // nothing falls back to itself rather than vanishing from the note.
      const nameOf = (list: { code: string; name: string }[], code: string) =>
        list.find((item) => item.code.trim().toUpperCase() === code.trim().toUpperCase())?.name ?? code;
      const noteParts: string[] = [];
      if (matrixFilter.regionCodes.length > 0) {
        noteParts.push(`Region: ${matrixFilter.regionCodes.map((code) => nameOf(details.options.regions, code)).join(", ")}`);
      }
      if (matrixFilter.areaCodes.length > 0) {
        noteParts.push(`Area: ${matrixFilter.areaCodes.map((code) => nameOf(details.options.areas, code)).join(", ")}`);
      }
      if (matrixFilter.productCodes.length > 0) {
        noteParts.push(`Product: ${matrixFilter.productCodes.map((code) => nameOf(details.options.products, code)).join(", ")}`);
      }
      if (distributorCodes.length > 0) {
        noteParts.push(`Distributor: ${distributorCodes.map((code) => nameOf(comparison.distributors, code)).join(", ")}`);
      }
      if (inclusion === "included") noteParts.push("Rows feeding the closing only");
      if (inclusion === "excluded") noteParts.push("Excluded rows only");
      if (detailSearch.trim()) noteParts.push(`Search: "${detailSearch.trim()}"`);
      if (matrixFilter.search.trim()) noteParts.push(`Area search: "${matrixFilter.search.trim()}"`);
      const filterNote = noteParts.length > 0
        ? `Filtered export — this workbook covers only: ${noteParts.join(" · ")}.`
          + (rowLevelActive
            ? " Targets are set per area & product company-wide and cannot be sliced this way, so"
              + " Target vs Achievement and the Direct channel rows are omitted."
            : "")
        : undefined;

      const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparison, details, {
        filterNote,
        includeTargetSheet: !rowLevelActive,
      });
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
      filters: detailFilters,
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
