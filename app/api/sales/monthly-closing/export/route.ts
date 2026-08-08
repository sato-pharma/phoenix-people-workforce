import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  loadMonthlyClosingComparison,
  loadMonthlyClosingComparisonFromRows,
} from "@/lib/sales/monthly-closing-comparison";
import {
  loadMonthlyClosingChannelBreakdown,
  loadMonthlyClosingChannelComparison,
} from "@/lib/sales/monthly-closing-channel-comparison";
import { type ClosingDetailsFilters, loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { closingFileName, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import {
  buildClosingDetailsWorkbook,
  buildMonthlyClosingWorkbook,
  buildPortalClosingWorkbook,
} from "@/lib/sales/monthly-closing-export";
import { loadPortalMonthlyClosing } from "@/lib/sales/monthly-closing-portal";
import {
  filterMonthlyClosingMatrix,
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
  loadMonthlyClosingParts,
  rebuildMatrixFromRows,
} from "@/lib/sales/monthly-distributor-import";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { prepareClosingStoreSplit } from "@/lib/sales/closing-store-split-export";
import { applyJulyDirectAreasToBreakdown } from "@/lib/sales/july-direct-channel-breakdown";
import { loadMonthlySourceCoverage } from "@/lib/sales/source-coverage";
import {
  applyStoreSplitToChannelBreakdown,
  planChannelBreakdownStoreSplit,
} from "@/lib/sales/store-split-channel-breakdown";
import { applyStoreSplitToMatrix } from "@/lib/sales/store-split-matrix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    // The full 6-sheet workbook (Matrix, Distributor Comparison, Rankings, Gaps, Summary, plus the
    // Data/Total audit pair) goes to Super Admin/system scope AND SFE Manager. loadMonthlyClosing
    // and loadMonthlyClosingComparison read company-wide and take no account of WHO is asking — the
    // scope passed below is the reader's on-screen filter, a convenience, never a permission
    // boundary. Confidential products and the Head Office line stay locked out independently, deep
    // inside loadMonthlyClosingDetails (canViewRestrictedProducts / canViewHeadOfficeLine, CEO /
    // Super Admin only) — so admitting SFE Manager here cannot leak either.
    //
    // SFE Manager was added 2026-08-05 (PR #1785, follow-up fix same day): the admin page already
    // shows him this exact matrix, view + download only, never publish (publish stays hard-gated to
    // Super Admin independently in publish/route.ts). His export must match what his own screen
    // shows rather than silently falling back to the scoped-role branch below, which is built for
    // District/Regional/National Sales Manager and PM/GPM and returns a different, lesser workbook.
    if (access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager") {
      // Server-load the full report (matrix + distributor comparison + insights). The body is
      // only the line/period selection — never trusted for data or authorization.
      // The combined matrix AND its two halves. The channel tabs need retail-without-direct and
      // direct-without-retail, and both must come from this one read so they cannot disagree with
      // the master they sit beside.
      const parts = await loadMonthlyClosingParts({ line: body.line ?? null, period: body.period ?? null });
      const matrix = filterMonthlyClosingMatrix(parts.combined, matrixFilter);
      // The retail half takes the IDENTICAL place filter, so an area on the Retail tab is the same
      // area the master shows.
      const retailFiltered = filterMonthlyClosingMatrix(parts.retail, matrixFilter);

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
      //
      // PLACE NARROWING HAPPENS AFTER THIS LOAD, NOT INSIDE IT. The store split shares a
      // wholesaler's sell-in across the areas of its city, and that allocation belongs to the
      // MONTH — a store in Alex East selling 750 boxes is 250 / 250 / 250 across Alex East, Alex
      // West and Alex Center whether or not the export shows all three. Narrowing here instead
      // would lose money in both directions: an in-scope store's share to excluded areas is
      // dropped, and an in-scope area never receives its share from an excluded store in the same
      // city. Row-level filters (distributor, Included/Excluded, search) DO belong here — they
      // define the population being allocated, not where it lands.
      const detailsPromise = loadMonthlyClosingDetails({
        access,
        line: matrix.line,
        period: matrix.period,
        availableLines: matrix.availableLines,
        availablePeriods: matrix.availablePeriods,
        filters: { ...detailFilters, areaCodes: [], regionCodes: [] },
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
      // Completeness sheet data, started alongside the heavy reads. Degrades to null (the sheet
      // is omitted) rather than ever costing the workbook.
      const coveragePromise = loadMonthlySourceCoverage(matrix.line, matrix.period).catch(() => null);

      // Channel Comparison — the ONLY sheet that reaches outside the exported month, so it is the
      // only one the route has to fetch extra data for. It covers the whole line across every
      // month up to and including this one, which is exactly why it is dropped from any FILTERED
      // export: a whole-line, whole-history comparison sitting beside a workbook narrowed to one
      // region, product or distributor would describe a different population than every sheet
      // around it. One RPC for the whole block, plus one target read per month.
      //
      // Restricted products are NOT revealed here even for a CEO who opted in, because every
      // closing RPC (phx_monthly_closing_matrix, phx_closing_distributor_product, phx_closing_*)
      // hard-excludes them in SQL. Following the opt-in would make this the one sheet that
      // disagrees with the Closing Matrix beside it; the sheet states which view produced it.
      const channelEligible = !rowLevelActive && !placeNarrowed && matrixFilter.productCodes.length === 0;
      const channelComparisonPromise = channelEligible
        ? loadMonthlyClosingChannelComparison(
          matrix.line,
          // Every validated month of this line up to and including the exported one — a trend
          // that ends where the workbook does, never one that runs past it.
          matrix.availablePeriods.filter((candidate) => !matrix.period || candidate <= matrix.period),
        ).catch(() => null)
        : Promise.resolve(null);
      // The same channel money cut by product, rep, area and brick — this month only, so it needs
      // no period list. Same eligibility as above for the same reason.
      const channelBreakdownPromise = channelEligible
        ? loadMonthlyClosingChannelBreakdown(matrix.line, matrix.period).catch(() => null)
        : Promise.resolve(null);

      // Every row of the month in the caller's scope, place filter NOT yet applied — the input the
      // store split has to see to allocate a city correctly.
      const monthRows = await detailsPromise;
      // Allocate over the whole month, THEN narrow to the areas on show. That order is the fix and
      // it lives in the domain module, not here — see closing-store-split-export.ts.
      const {
        details,
        exemptStoreValueByBrick: storeSplitExemptByBrick,
        movements: storeSplitMovements,
        net: storeSplitNet,
      } = prepareClosingStoreSplit(monthRows, scopedAreaCodes);
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
      const rebuiltMatrix = rowLevelActive ? rebuildMatrixFromRows(matrix, details.rows) : matrix;

      // The store split. A wholesaler supplies its whole city rather than only the area it stands
      // in, so its sell-in on Pedia / Anti Infective / CNS is shared evenly across that city's
      // areas and each area's share reaches whoever holds its line seat. SALES move; TARGETS are
      // never touched, so achievement re-derives as the new sales over the same target.
      //
      // Computed from `monthRows` — the whole month — so an area's number is the same in this
      // workbook as in the unfiltered one. On a whole-month export the grand total cannot move
      // (a store's sale is redistributed inside one city and one product). On a FILTERED export it
      // does move, because part of the allocation belongs to areas that are not on show, and
      // `storeSplitApplied` is exactly that amount — stated on the Total sheet as its own
      // reconciliation line rather than quietly disappearing from the headline.
      const { applied: storeSplitApplied, matrix: workbookMatrix } = applyStoreSplitToMatrix(
        rebuiltMatrix,
        storeSplitNet,
      );

      // The channel tabs. The retail half gets the SAME split write-back as the master — the split
      // only ever moves distributor (retail) money between areas of one city, so applying it to the
      // retail grid is what keeps "Retail + Direct = master" true cell by cell.
      //
      // Omitted under a row-level filter: there the master is rebuilt from invoice rows and direct
      // is dropped entirely (a distributor or Included/Excluded slice has no direct equivalent), so
      // a channel pair would tie to nothing. Same honesty rule as the Target vs Achievement sheet.
      const channels = rowLevelActive
        ? null
        : {
          retail: applyStoreSplitToMatrix(retailFiltered, storeSplitNet).matrix,
          directCells: parts.directCells,
        };

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
          + (channelEligible
            ? ""
            : " The two Channel sheets are omitted too: they cover the WHOLE line, so they cannot be"
              + " narrowed to this slice without describing a different population than the rest of"
              + " the workbook. Export without filters to see them.")
        : undefined;

      // The Channel Breakdown grids get the SAME store city split the matrix just got, for the same
      // reason: a wholesaler supplies its whole city, so its sell-in belongs to every area of that
      // city and to whoever holds each area's seat. Without this, one workbook published two
      // different numbers for the same area — the Matrix halving D15 across Gharbia while the Area ×
      // Channel grid kept all of it on D15 — and the rep grid credited the lot to a single rep.
      //
      // Applied HERE rather than inside the loader, exactly as applyStoreSplitToMatrix is: the two
      // write-backs sit side by side so neither can be added without the other being noticed. The
      // sheet states on itself whether the split reached it, so a future caller that skips this line
      // produces a workbook that says so rather than a workbook that quietly disagrees.
      // The SAME movements applyStoreSplitToMatrix was given, not a second derivation of them: that
      // shared origin is what makes the Area × Channel grid agree with the Closing Matrix area for
      // area. Deriving them again from the grid's own figures put six Anti Infective areas and
      // eleven Pedia areas out of step, because the RPC reads a customer's name from the directory
      // rollup while these rows carry the name the distributor put on the invoice line.
      //
      // July 2026's hand-mapped direct orders are re-attributed FIRST, in the same order the matrix
      // does it: direct money lands on real areas, and the store split then moves that area's whole
      // cell exactly as it moves the matrix's. Reversing the two would split a number the direct
      // money had not joined yet.
      const rawBreakdown = await channelBreakdownPromise;
      const julyDirect = rawBreakdown ? applyJulyDirectAreasToBreakdown(rawBreakdown) : null;
      const seatedBreakdown = julyDirect?.breakdown ?? rawBreakdown;
      const channelBreakdown = seatedBreakdown
        ? applyStoreSplitToChannelBreakdown(
          seatedBreakdown,
          // The exempt-by-brick map travels with the movements: the brick grid reads its own figures
          // and cannot otherwise tell that part of a brick's store money belongs to a customer the
          // Matrix deliberately left alone.
          planChannelBreakdownStoreSplit(seatedBreakdown, storeSplitMovements, storeSplitExemptByBrick),
        )
        : null;

      const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparison, details, {
        channelBreakdown,
        channelComparison: await channelComparisonPromise,
        channels,
        coverage: await coveragePromise,
        filterNote,
        includeTargetSheet: !rowLevelActive,
        // The whole month's rows drive the Store Split sheet, so a reader who filtered to one area
        // can still see WHERE the rest of that city's share went; `storeSplitScopeAreaCodes` marks
        // which of those areas this workbook actually covers.
        storeSplitApplied,
        storeSplitRows: monthRows.rows,
        storeSplitScopeAreaCodes: scopedAreaCodes,
      });
      // The region comes from the matrix the workbook was actually built from, so a filtered export
      // is named for the region it was narrowed to rather than for the whole line.
      return fileResponse(buffer, closingFileName({
        line: matrix.line ?? "",
        period: matrix.period ?? "",
        region: regionScopeLabel((function* () {
          for (const region of workbookMatrix.regions) {
            yield region.regionName;
          }
        })()),
      }));
    }

    // Every other scoped sales role (District/Regional/National Sales Manager, Product/Group
    // Product Manager, and any other "sales: read" role — SFE Manager is carved out above) can
    // export exactly what the Details tab shows them: the raw rows already scoped by
    // loadMonthlyClosingDetails (line, region, per-user product allowlist, confidential lock). No
    // Matrix/Comparison sheets — those loaders are unscoped and would leak data outside this
    // caller's access if included here.
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

    // This viewer's OWN scoped Closing Matrix — the exact one their portal screen already shows
    // (loadPortalMonthlyClosing narrows by line/region/area/product and strips confidential
    // columns; publish-gated, same as the portal page). Null for a role loadPortalMonthlyClosing
    // has no scope for, or a period that is not (yet) published — the export then degrades to the
    // Data/Total-only workbook rather than failing outright.
    const portalClosing = await loadPortalMonthlyClosing({ access, period: details.period }).catch(() => null);
    const buffer = portalClosing?.matrix
      ? await buildPortalClosingWorkbook(
          portalClosing.matrix,
          // Built from the SAME already-scoped rows the Data sheet lists — never a company-wide
          // read — so the Matrix tab's ClosingExportData (Calc sheet) cannot disagree with Data.
          await loadMonthlyClosingComparisonFromRows(details.line, details.period, details.rows),
          details,
        )
      : await buildClosingDetailsWorkbook(details);
    // These rows are already narrowed to this caller's own access, so a District Manager's file is
    // named for their region without the route having to re-derive the scope.
    return fileResponse(buffer, closingFileName({
      kind: "details",
      line: details.line,
      period: details.period,
      region: regionScopeLabel((function* () {
        for (const row of details.rows) {
          yield row.regionName;
        }
      })()),
    }));
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
