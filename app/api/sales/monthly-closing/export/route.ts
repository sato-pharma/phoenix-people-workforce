import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  loadMonthlyClosingComparison,
  loadMonthlyClosingComparisonFromRows,
} from "@/lib/sales/monthly-closing-comparison";
import {
  loadMonthlyClosingChannelBreakdown,
  loadMonthlyClosingChannelComparison,
} from "@/lib/sales/monthly-closing-channel-comparison";
import { gateClosingDetailsPeriod } from "@/lib/sales/closing-details-publication-gate";
import { type ClosingDetailsFilters, loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { maskedClosingClientCodes, withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { resolveClosingFileName } from "@/lib/sales/closing-export-file-name";
import {
  buildScopedRepRankingExport,
  isRepRankingLine,
} from "@/lib/sales/closing-rep-ranking-export";
import {
  buildClosingDetailsWorkbook,
  buildMonthlyClosingWorkbook,
  buildPortalClosingWorkbook,
  directByTotalCell,
  fileDirectCellsUnderMatrixRegions,
} from "@/lib/sales/monthly-closing-export";
import {
  loadPortalMonthlyClosing,
  medicalRepComparisonScope,
  resolvePortalClosingScope,
} from "@/lib/sales/monthly-closing-portal";
import {
  MEDICAL_REP_AREA_UNRESOLVED_MESSAGE,
  resolveMedicalRepSosAreaCodes,
} from "@/lib/sales/medical-rep-area-scope";
import { MARKETING_OVERSIGHT_LINE_ROLES, normalizeLineKey } from "@/lib/sales/access-scope";
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
import { isFrozenStoreSplitPeriod, loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { isStoreCitySplitActive } from "@/lib/sales/store-sales-city-split";
import { applyJulyDirectAreasToBreakdown } from "@/lib/sales/july-direct-channel-breakdown";
import { loadMonthlySourceCoverage } from "@/lib/sales/source-coverage";
import {
  applyStoreSplitToChannelBreakdown,
  planChannelBreakdownStoreSplit,
} from "@/lib/sales/store-split-channel-breakdown";
import { applyStoreSplitToMatrix } from "@/lib/sales/store-split-matrix";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
    // Data/Total audit pair) goes to Super Admin/system scope, SFE Manager, and CEO.
    // loadMonthlyClosing and loadMonthlyClosingComparison read company-wide and take no account of
    // WHO is asking — the scope passed below is the reader's on-screen filter, a convenience, never
    // a permission boundary. Confidential products and the Head Office line stay locked out
    // independently, deep inside loadMonthlyClosingDetails (canViewRestrictedProducts /
    // canViewHeadOfficeLine, CEO / Super Admin only) — so admitting SFE Manager/CEO here cannot
    // leak either.
    //
    // SFE Manager was added 2026-08-05 (PR #1785, follow-up fix same day): the admin page already
    // shows him this exact matrix, view + download only, never publish (publish stays hard-gated to
    // Super Admin independently in publish/route.ts). His export must match what his own screen
    // shows rather than silently falling back to the scoped-role branch below.
    //
    // CEO was added 2026-08-08 (owner decision): CEO's sales-read scope is already company-wide
    // everywhere else in the app (scopeForRole -> "company"), so this branch does not widen his
    // access — it was previously the ONLY place CEO fell through to the scoped-role branch below,
    // which is built for District/Regional/National Sales Manager and PM/GPM and returns a
    // different, lesser workbook that does not match what CEO's own access already permits.
    // Finance Manager added 2026-08-10 (owner): full-scope Monthly Closing, ANY line, ALWAYS —
    // including periods that were never published. This branch is the only one that delivers that.
    // The scoped branch below is publication-gated: it refuses an unpublished (line, period) with a
    // 403 (closing-details-publication-gate.ts, since 2026-09-16 — before that it answered HTTP 200
    // with the unpublished month's rows, inside the newest PUBLISHED month's matrix, or in Data +
    // Total sheets when the line had nothing published). Even when published it omits Retail/Direct,
    // Store Split, Channel Comparison/Breakdown, Source Coverage and July Direct.
    //
    // Like the CEO note above, this does not widen him: getSalesScope already returns COMPANY for
    // the role, and the confidential/Head-Office locks named at the top of this comment are
    // untouched — canViewRestrictedProducts stays CEO + Super Admin only. On the closing that costs
    // him nothing, because every restricted row sits on Head Office and listMonthlyClosingLines
    // excludes Head Office for everyone, the CEO included.
    //
    // Marketing Manager added 2026-08-12 (owner: a Monthly Closing tab of her own, able to "export
    // any line full closing sheet"). She reaches this route from the portal tab
    // (/employee-portals/monthly-closing). Without this branch her Export XLSX fell to the scoped
    // one below and returned the lesser workbook — and on an unpublished month, Data + Total only,
    // HTTP 200, with nothing on screen or in the file saying so.
    //
    // Unlike the five roles above she is NOT company-scoped, so she is admitted for a line she
    // actually oversees and for nothing else. Her allowed set comes from the same engine the rest
    // of sales uses (resolvePortalClosingScope → resolveSalesAccessScope →
    // MARKETING_OVERSIGHT_LINE_ROLES), with the confidential Head Office line already filtered out
    // by canViewHeadOfficeLine. Today that set is Anti Infective / Pedia / CNS, which happens to be
    // every closeable line there is — but the check below is written against her SCOPE rather than
    // against that coincidence, so adding a fifth product line later cannot silently hand her a
    // full-company matrix for a line she does not oversee.
    const marketingOversight = MARKETING_OVERSIGHT_LINE_ROLES.has(access.role)
      ? await resolvePortalClosingScope(access)
      : null;
    // An out-of-scope line is REFUSED, never traded for one she does hold. loadMonthlyClosingParts
    // silently falls back to availableLines[0] for a line it does not recognise, so substituting
    // here would build a FULL workbook labelled for the line she asked for and filled with a
    // different line's figures — the exact silent-substitution failure pickPortalClosingLine exists
    // to prevent. Same 403 the scoped branch already returns for details.outOfScope.
    if (marketingOversight) {
      const requestedLine = String(body.line ?? "").trim();
      const inScope = marketingOversight.allowedLines.some(
        (candidate) => normalizeLineKey(candidate) === normalizeLineKey(requestedLine),
      );
      if (requestedLine && !inScope) {
        return NextResponse.json(
          { success: false, error: "Forbidden: this line is outside your access." },
          { status: 403 },
        );
      }
    }

    // APPEND ONLY. tests/sfe-manager-nav-dead-links.test.ts pins the first three terms of this
    // disjunction as a literal source substring, so adding to the end keeps it green while
    // reordering breaks it. Do not refactor this into a named predicate without moving that test.
    if (access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager" || access.role === "CEO" || access.role === "Finance Manager" || marketingOversight !== null) {
      // Server-load the full report (matrix + distributor comparison + insights). The body is
      // only the line/period selection — never trusted for data or authorization.
      // The combined matrix AND its two halves. The channel tabs need retail-without-direct and
      // direct-without-retail, and both must come from this one read so they cannot disagree with
      // the master they sit beside.
      // `marketingOversight.line` is her DEFAULT line, used only when the caller named none. Without
      // it a line-less export would take loadMonthlyClosingParts' own fallback (availableLines[0]),
      // which is company-wide and knows nothing about her oversight set. Null for every other role,
      // so their fallback is untouched.
      const parts = await loadMonthlyClosingParts({
        line: body.line ?? marketingOversight?.line ?? null,
        period: body.period ?? null,
      });
      const matrix = filterMonthlyClosingMatrix(parts.combined, matrixFilter);
      // The retail half takes the IDENTICAL place filter, so an area on the Retail tab is the same
      // area the master shows.
      const retailFiltered = filterMonthlyClosingMatrix(parts.retail, matrixFilter);
      // The Office slice takes the SAME place filter, so "of wh. Office" is always measured against
      // the rows the Matrix sheet actually kept. Null when it could not be read; the workbook then
      // simply omits the Office column and sheet rather than printing a column of zeroes.
      const officeFiltered = parts.office ? filterMonthlyClosingMatrix(parts.office, matrixFilter) : null;

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
      //
      // WATCH THIS ONE FOR THE MARKETING MANAGER. This read is scoped to the caller, and that scope
      // includes `app_auth_users.product_scope_override` as a HARD row filter, while the Matrix
      // sheet above comes from the unscoped loadMonthlyClosingParts. For the four company-scope
      // roles that is a no-op — none carries an override. A-9 does: 23 product codes, a
      // Product-Manager-shaped control sitting on a role that oversees three whole lines.
      //
      // Topped up from 21 to 23 on 2026-08-12 (owner) with TE006 Tebofortin Intens and TE007
      // Tebofortin Max. Verified live the same day: the list now covers 100% of the ACTIVE products
      // on all three of her lines — Anti Infective 2/2, CNS 17/17, Pedia 4/4 — so both halves of
      // this workbook draw from one population and the Matrix cannot carry a column the Data/Total
      // audit pair lacks.
      //
      // THE STANDING OBLIGATION: any product launching on Anti Infective / Pedia / CNS must be added
      // to that override, or this workbook silently stops tying — HTTP 200, no error, nothing on any
      // sheet saying so. That is the running cost of the list, and it was accepted deliberately.
      //
      // DO NOT "SIMPLIFY" THIS BY CLEARING THE OVERRIDE. An earlier version of this comment
      // recommended exactly that, reasoning that she oversees whole lines so a per-product allowlist
      // does not describe her. It is wrong, and the reason is not visible from this file: her
      // `sales_scope_override` is COMPANY, so computeSalesAccessScope returns allowedLineNames null
      // — EVERY line, not her three. Her product list is therefore also the second guard holding the
      // confidential Head Office line out of her reads. LA003/LA004/SS001 are covered independently
      // by RESTRICTED_PRODUCT_CODES, but RY001 (ROYANOXICAM 8MG 20 TAB) is NOT restricted and it
      // SELLS — 217 rows, 10,458 EGP, 2026-01 to 2026-07. Clear the list and the only thing left is
      // stripHeadOfficeRows, which passes through rows that carry no line dimension.
      //
      // And never un-scope this read to make a sheet balance — widening what a caller may see is how
      // a confidential product reaches a workbook.
      const detailsPromise = loadMonthlyClosingDetails({
        access,
        line: matrix.line,
        period: matrix.period,
        availableLines: matrix.availableLines,
        availablePeriods: matrix.availablePeriods,
        filters: { ...detailFilters, areaCodes: [], regionCodes: [] },
        includeConfidential: body.includeConfidential === true,
        unpaged: true,
        // 🔒 The split and the matrix rebuild below BOTH key on the real distributor, so this
        // read reveals and the mask is applied on the way into the workbook instead. Masking here
        // would not throw — it would quietly export a different distribution from the screen's.
        revealSource: true,
      });
      // Started here, awaited below. Null when the comparison must be rebuilt from the detail
      // rows, which cannot begin until those rows exist.
      const aggregateComparisonPromise = comparisonFromRows
        ? null
        // `access`: the comparison names distributors, so it masks El Qema for this reader itself.
        // `organogram`: its sheets name the matrix's regions, not the map's (owner, 2026-09-16).
        : loadMonthlyClosingComparison(matrix.line, matrix.period, { areaCodes: scopedAreaCodes }, access, { regionBasis: "organogram" });
      // An in-flight promise whose rejection is never awaited is an UNHANDLED rejection, which can
      // take the process down. If the details read below throws first we leave this scope without
      // ever awaiting this one, so park a no-op handler now. The real `await` still surfaces the
      // error normally — attaching a catch does not swallow it for the awaiting caller.
      aggregateComparisonPromise?.catch(() => {});
      // Completeness sheet data, started alongside the heavy reads. Degrades to null (the sheet
      // is omitted) rather than ever costing the workbook.
      const coveragePromise = loadMonthlySourceCoverage(matrix.line, matrix.period, access).catch(() => null);

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

      // THE SCREEN'S OWN SPLIT, so the workbook cannot disagree with the Closing Matrix.
      //
      // Until 2026-08-11 this route always re-derived the split from its own freshly read rows while
      // the screen read loadClosingStoreSplit's cache — two derivations of one rule, one live and one
      // up to an hour old. A cross-city customer re-point therefore moved the workbook's area rows
      // and left the screen's alone, which is indistinguishable to a reader from the recalculation
      // bug fixed in monthly-closing-export.ts. Same computation now, or none.
      //
      // Skipped under a ROW-LEVEL filter only. There the population is genuinely different — a
      // distributor or Included/Excluded slice is not the whole month — so the split must be derived
      // from those rows, and the workbook's filter note already says it covers a narrowed slice.
      // A PLACE filter does not disqualify it: prepareClosingStoreSplit allocates over the whole
      // month and narrows afterwards, which is the entire point of that module.
      //
      // `includeConfidential` deliberately does NOT disqualify it either. The shared split is
      // computed with confidential products excluded, which is exactly the population the Closing
      // Matrix holds (every closing RPC hard-excludes them in SQL) — so it is the correct input for
      // the matrix write-back whether or not the reader opted into the confidential DATA sheet.
      // `&& isStoreCitySplitActive(...)`: the split is off before August 2026 (owner, 2026-09-04 —
      // July stays as published) and can be turned off entirely again, and in both cases the loader
      // returns the EMPTY split — so even a row-level filter must receive that rather than `null`,
      // because null tells prepareClosingStoreSplit to derive its own split live from the rows,
      // which is exactly the apply path being switched off. Asking the PERIOD and not the bare flag
      // is what stops a row-level filtered export of July splitting when the screen's July does not.
      const sharedSplitPromise = rowLevelActive && isStoreCitySplitActive(matrix.period)
        ? Promise.resolve(null)
        : loadClosingStoreSplit(matrix.line, matrix.period).catch(() => null);

      // Every row of the month in the caller's scope, place filter NOT yet applied — the input the
      // store split has to see to allocate a city correctly.
      const monthRows = await detailsPromise;
      // Allocate over the whole month, THEN narrow to the areas on show. That order is the fix and
      // it lives in the domain module, not here — see closing-store-split-export.ts. A null shared
      // split (row-level filter, or a cache read that failed) falls back to deriving it from these
      // rows, which is the previous behaviour and still correct — just no longer guaranteed to equal
      // the screen.
      const {
        details,
        exemptStoreValueByBrick: storeSplitExemptByBrick,
        movements: storeSplitMovements,
        net: storeSplitNet,
        officeNet: storeSplitOfficeNet,
      } = prepareClosingStoreSplit(monthRows, scopedAreaCodes, await sharedSplitPromise);
      // 🔴 THE OFFICE GRID TAKES THE OFFICE RESPREAD'S OWN NET, AND NOTHING ELSE OF `storeSplitNet`
      // (owner, 2026-10-09 — CNS, from the October closing). The matrix below moves the Office units
      // onto today's value shares; an Office grid left on the areas the upload stamped would make
      // "of wh. Office" describe a different geography from the matrix beside it, and the Closing
      // Matrix (No Office) tab — `matrix − office`, cell by cell — could print negative sales. The
      // city split and the bulk allocation must NOT reach this grid: neither moves an Office row.
      // Applied AFTER the place filter, exactly as the retail half is, so both grids are narrowed the
      // same way before any net lands. Empty on every line but CNS and every month before 2026-10.
      const officeGrid = officeFiltered && storeSplitOfficeNet.size > 0
        ? applyStoreSplitToMatrix(officeFiltered, storeSplitOfficeNet).matrix
        : officeFiltered;
      // The split is FROZEN only when the shared (whole-month) split was used AND the period is frozen
      // — exactly when `storeSplitMovements` above are the frozen ones. isFrozenStoreSplitPeriod is the
      // SAME per-period predicate loadFrozenStoreSplitIfPublished uses to decide to freeze, so the
      // banner and the frozen summary cannot disagree (a per-LINE check would miss a partially-published
      // period, where the split is frozen but this line's own row is not yet published). A row-level
      // filtered export derives its own live split over a different population, so it is never frozen.
      const storeSplitFrozen = !rowLevelActive && (await isFrozenStoreSplitPeriod(matrix.line, matrix.period));
      const comparison = aggregateComparisonPromise
        ? await aggregateComparisonPromise
        : await loadMonthlyClosingComparisonFromRows(
          matrix.line,
          matrix.period,
          details.rows,
          // Masters still narrow to the filtered place so white-space denominators stay honest;
          // the leaves are already exactly the filtered rows.
          { areaCodes: scopedAreaCodes },
          // These rows were read with the real source, so the loader masks them for this reader.
          access,
          { regionBasis: "organogram" },
        );

      // Under a row-level filter the aggregate matrix cannot express the slice — rebuild its
      // cells from the same rows, so sheet 1 and the audit pair describe one population.
      //
      // `includeDirect` because such a slice CAN contain direct money: `DIRECT` is itself a
      // selectable distributor (51 rows / 1,208,548.15 EGP in 2026-07), and an Excluded or
      // free-text filter can match direct rows too. Without it, "Distributor = DIRECT" returned a
      // Closing Matrix of zeros beside a Data sheet listing every one of those rows — and the
      // Total sheet still read Difference 0, because the bridge was zero as well. A real
      // distributor's slice is unaffected: it contains no direct rows to fold in.
      const rebuiltMatrix = rowLevelActive
        ? rebuildMatrixFromRows(matrix, details.rows, { includeDirect: true })
        : matrix;
      // Stated on the Total sheet, because a rebuilt slice has no retail half to subtract. Derived
      // as (with direct) minus (without) so a direct row whose area or product is absent from this
      // matrix — never placed in a cell — is not bridged as if it were on the sheet.
      const invoiceOnly = rowLevelActive ? rebuildMatrixFromRows(matrix, details.rows) : null;
      const directPlaced = invoiceOnly
        ? {
          units: rebuiltMatrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0)
            - invoiceOnly.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
          value: rebuiltMatrix.grandTotal.rowTotal.salesValue - invoiceOnly.grandTotal.rowTotal.salesValue,
        }
        : undefined;
      // The same difference cell by cell, so the Total sheet adds each area its own direct.
      const directPlacedCells = invoiceOnly ? directByTotalCell(rebuiltMatrix, invoiceOnly) : undefined;

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
      const {
        applied: storeSplitApplied,
        cells: storeSplitCells,
        matrix: workbookMatrix,
      } = applyStoreSplitToMatrix(rebuiltMatrix, storeSplitNet);

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
          // Under the region the WHOLE month's matrix files each order's area in, so a direct order on
          // an area the organogram re-owns is not dropped from both channel tabs. See the helper.
          directCells: fileDirectCellsUnderMatrixRegions(parts.directCells, parts.combined),
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
          + (rowLevelActive && officeFiltered
            ? " The \"of wh. Office\" figures are the WHOLE month's Office component and are NOT"
              + " narrowed by this filter: Office rows carry no customer and no distributor, so"
              + " there is nothing in them for a row-level filter to match."
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

      // 🔒 Everything that computes from the real rows is finished by here — the split, the
      // comparison, both matrix rebuilds. The workbook only writes them out, so this is where
      // the source mask belongs. See closing-source-mask.ts.
      const shownMatrixDetails = { ...details, rows: [...withoutMaskedSourceRows(details.rows, access)] };
      const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparison, shownMatrixDetails, {
        channelBreakdown,
        channelComparison: await channelComparisonPromise,
        channels,
        coverage: await coveragePromise,
        // Only set under a row-level filter, where `channels` is null and the Total sheet has no
        // retail half to derive the direct bridge from.
        directPlaced,
        directPlacedCells,
        filterNote,
        includeTargetSheet: !rowLevelActive,
        // ALWAYS carried, so the workbook shows what the SCREEN shows. Owner's rule, 2026-08-26:
        // "the export must be typical the front end — never different data". Office is 41% of the
        // CNS closing, and this gate dropped it under any row-level filter while the on-screen
        // Closing Matrix kept showing it — the one omission the filter note never announced.
        //
        // The Office grid genuinely cannot be narrowed by a row-level filter: loadMonthlyClosingParts
        // builds it from an aggregate that carries no customer and no distributor. So rather than
        // hide it, the note below states in words that these figures are the whole month's Office.
        office: officeGrid,
        // Whether the Office grid above is comparable with the matrix, which is what decides the
        // "Closing Matrix (No Office)" tab. Under a row-level filter it is NOT — the note three
        // lines up says so in words — and subtracting the whole month's Office from a narrowed
        // matrix would print negative sales, so the tab is absent there rather than wrong.
        officeNarrowedWithMatrix: !rowLevelActive,
        // The whole month's rows drive the Store Split sheet, so a reader who filtered to one area
        // can still see WHERE the rest of that city's share went; `storeSplitScopeAreaCodes` marks
        // which of those areas this workbook actually covers.
        storeSplitApplied,
        storeSplitCells,
        // The frozen (or, for a live month, the same live) movements the Matrix used, so the Store
        // Split summary's net ties to the Matrix rather than to a second recompute.
        storeSplitMovements,
        storeSplitFrozen,
        storeSplitRows: monthRows.rows,
        // Computed from the REAL rows above; the answer is masked by code, because a split
        // entry carries no distributor to recognise. See closing-source-mask.ts.
        storeSplitMaskedClients: maskedClosingClientCodes(details.rows, access),
        storeSplitRegions: await loadSplitRegions(matrix.line, matrix.period),
        storeSplitScopeAreaCodes: scopedAreaCodes,
      });
      // The region comes from the matrix the workbook was actually built from, so a filtered export
      // is named for the region it was narrowed to rather than for the whole line.
      return fileResponse(buffer, await resolveClosingFileName({
        line: matrix.line ?? "",
        period: matrix.period ?? "",
        regionNames: ((function* () {
          for (const region of workbookMatrix.regions) {
            yield region.regionName;
          }
        })()),
      }));
    }

    // Every other scoped sales role (District/Regional/National Sales Manager, Product/Group
    // Product Manager, Medical Rep, and any other "sales: read" role — SFE Manager is carved out
    // above) can export exactly what the Details tab shows them: the rows already scoped by
    // loadMonthlyClosingDetails (line, region, per-user product allowlist, confidential lock). No
    // Matrix/Comparison sheets — those loaders are unscoped and would leak data outside this
    // caller's access if included here.
    const [availableLines, availablePeriods] = await Promise.all([
      listMonthlyClosingLines(),
      listMonthlyClosingPeriods(),
    ]);
    // PUBLISHED MONTHS ONLY, checked before a single row is read. This branch used to load the rows
    // of any validated month and download them with HTTP 200, to a scoped viewer whose own screen
    // could not show that month. Worse, loadPortalMonthlyClosing below answers an unpublished month
    // with the NEWEST PUBLISHED one, so the file named for the unpublished month carried its sales
    // inside the published month's products, targets and Office grid (Data + Total sheets only when
    // the line had nothing published). Checked here, that call always gets the month it was asked
    // for. Every reader the full-workbook branch above admits returned before this line, so nobody
    // who keeps unpublished months is gated here. See closing-details-publication-gate.ts.
    const gate = await gateClosingDetailsPeriod({
      access,
      line: body.line ?? null,
      requestedPeriod: body.period ?? null,
      availableLines,
      includeConfidential: body.includeConfidential === true,
    });
    if (gate.kind === "refused") {
      return NextResponse.json({ success: false, error: gate.error }, { status: 403 });
    }
    // 🔴 NOT REVEALED — THE FILE IS THE VIEWER'S OWN DETAILS TAB, and that is what makes its totals
    // their screen's. Owner, 2026-09-16, choosing "Fix every scoped file now" after being shown a
    // Medical Rep's file at 23,007 EGP beside a screen at 82,981 for the same area and month.
    //
    // Read revealed, as it was until then, the loader handed back the rows AS INVOICED: every store
    // row still in the area that invoiced it, and El Qema's warehouse rows in the warehouses' own
    // areas, which the mask below then removed. The file's Closing Matrix, Target vs Achievement and
    // Total are all rebuilt from these rows, so every scoped file lacked its area's share of the city
    // split and all of Main Stores. Unrevealed, the loader does both passes over the WHOLE month with
    // the real source before it scopes — credited shares, and Main Stores standing in for El Qema —
    // which is the arithmetic the screen's matrix was built from. Nothing below needs the real
    // distributor any more: the one computation left, the comparison, files Main Stores under `—`.
    //
    // The full-workbook branch above still reveals, because it runs that split itself.
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

    // This viewer's OWN scoped Closing Matrix skeleton, from loadPortalMonthlyClosing — narrowed by
    // line/region/area/product and confidential-stripped, publish-gated, the exact matrix their
    // portal screen shows. District/Regional/National Manager and Product/Group Product Manager.
    //
    // The Marketing Manager had a second source here (loadMonthlyClosingWithStoreSplit, keyed on
    // MARKETING_OVERSIGHT_LINE_ROLES) because her boundary is WHICH lines rather than which
    // areas/products within one. It is gone because she now takes the full-workbook branch above,
    // which is what the owner actually asked for — that set holds only her, so the branch was
    // unreachable and would have rotted here as a second, lesser answer to a question this route no
    // longer asks her.
    //
    // `line: details.line` IS LOAD-BEARING, not tidying. The skeleton is not decoration:
    // buildPortalClosingWorkbook rebuilds it with `preserveTargets: true`, so the workbook's PRODUCT
    // COLUMNS and every TARGET come from the skeleton while only the sales come from the rows.
    // Resolve the skeleton from the viewer's default line rather than the line being exported, and a
    // two-line manager — a Product Manager holding Pedia + Anti Infective through
    // line_scope_override — exporting his second line gets the FIRST line's products and the FIRST
    // line's targets wrapped around the second line's rows, with the exported sales silently dropped
    // because they have no column to land in. Nothing on the sheet would say so.
    // loadPortalMonthlyClosing REFUSES a line outside the caller's scope instead of substituting a
    // different one, so the worst case is the honest rows-only workbook below, never a mislabelled one.
    // ONE read, reused twice: the matrix skeleton and the Office grid come out of the same
    // loadPortalMonthlyClosing call, so the "of which Office" figures a viewer downloads are scoped
    // by exactly the chain that scoped the sales beside them and cannot drift from their screen.
    //
    // The office-differentiation work this came from branched on MARKETING_OVERSIGHT_LINE_ROLES
    // here, reading loadMonthlyClosingWithStoreSplit for the Marketing Manager. That is deliberately
    // NOT carried over: it was written against a tree where she still reached this line, and the
    // note above records why she no longer does — she is admitted by `marketingOversight !== null`
    // to the full-workbook branch further up and returns there. The branch would be dead code, and
    // loadMonthlyClosingWithStoreSplit is not even imported here any more.
    //
    // 🔴 A MEDICAL REP'S FILE ONLY — the owner's decision, 2026-09-16, taken because this export is
    // frozen. The comparison sheets measure white space against every area and brick in the company,
    // so with no scope a rep's Gaps & White-Space and Calc sheets named every other area in the
    // country, the sibling reps' areas included, as "zero sales". Narrowed to the rep's own areas (see
    // medicalRepComparisonScope). Every other viewer keeps `undefined` exactly as before, so no other
    // viewer's comparison is narrowed by this.
    const repComparisonScope = access.role === "Medical Rep"
      ? medicalRepComparisonScope(await resolveMedicalRepSosAreaCodes(access))
      : undefined;
    if (repComparisonScope === null) {
      return NextResponse.json(
        { success: false, error: MEDICAL_REP_AREA_UNRESOLVED_MESSAGE },
        { status: 403 },
      );
    }
    const scopedPortal =
      await loadPortalMonthlyClosing({ access, line: details.line, period: details.period }).catch(() => null);
    const scopedMatrix = scopedPortal?.matrix ?? null;

    // 🔴 ANTI INFECTIVE'S PORTAL EXPORT IS THE REP RANKING WORKBOOK (owner, 2026-10-13: "wire this
    // sheet instead of the current sheet in the employee portal … forget about the other sheet. This
    // will replace it in the employee portal, any role", and — asked which lines — "wire this only to
    // the anti-infective line. Leave PD and CNS as they are").
    //
    // It REPLACES this branch's file for that line and no other; CNS and Pedia fall straight through
    // to the workbook below, exactly what they produced before. The frozen-export rule still holds
    // for them: he named this line himself, which is what that rule asks for.
    //
    // Scope is not re-derived here — buildScopedRepRankingExport asks loadPortalMonthlyClosing for
    // each trend month, so every month is narrowed and publish-gated by the same chain that scoped
    // the matrix above. A Medical Rep's own-area scope therefore makes his ranking his own row, which
    // is his decision of 2026-10-13 and keeps the own-area-never-region lock intact.
    //
    // It returns null rather than throwing when a ranking cannot be built for this viewer and month,
    // and the request then produces the ordinary scoped workbook: a gap degrades to the old file,
    // never to an error page.
    if (isRepRankingLine(details.line)) {
      const ranked = await buildScopedRepRankingExport({
        access,
        availablePeriods: scopedPortal?.availablePeriods ?? availablePeriods,
        line: details.line,
        period: details.period,
        rows: details.rows,
      });
      if (ranked) {
        return fileResponse(ranked.buffer, await resolveClosingFileName({
          kind: "details",
          line: details.line,
          period: details.period,
          regionNames: ((function* () {
            for (const row of details.rows) {
              yield row.operationalRegionName || row.regionName;
            }
          })()),
        }));
      }
    }

    // 🔒 EVERYTHING ABOVE THIS LINE HAS FINISHED COMPUTING. From here the rows are only written
    // into a workbook, so this is where the source mask belongs. See closing-source-mask.ts. The rows
    // arrive masked already (they were not revealed); the drop stays as the guard on the way into the
    // workbook, so a reveal added back above can never print El Qema's name.
    const shownDetails = { ...details, rows: [...withoutMaskedSourceRows(details.rows, access)] };
    const buffer = scopedMatrix
      ? await buildPortalClosingWorkbook(
          scopedMatrix,
          // Built from the SAME already-scoped rows the Data sheet lists — never a company-wide
          // read — so the Matrix tab's ClosingExportData (Calc sheet) cannot disagree with Data.
          // `access` still masks any El Qema leaf; Main Stores rows go under `—` in the leaves.
          // `organogram`: its sheets name the matrix's regions, not the map's (owner, 2026-09-16).
          await loadMonthlyClosingComparisonFromRows(details.line, details.period, details.rows, repComparisonScope, access, { regionBasis: "organogram" }),
          shownDetails,
          // Same read as the skeleton, so the Office grid is never company-wide beside scoped sales.
          scopedPortal?.office ?? null,
        )
      : await buildClosingDetailsWorkbook(shownDetails);
    // These rows are already narrowed to this caller's own access, so a District Manager's file is
    // named for their region without the route having to re-derive the scope. The matrix's region,
    // as on every sheet inside the file.
    return fileResponse(buffer, await resolveClosingFileName({
      kind: "details",
      line: details.line,
      period: details.period,
      regionNames: ((function* () {
        for (const row of details.rows) {
          yield row.operationalRegionName || row.regionName;
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
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to export Monthly Closing.") },
      { status: 500 },
    );
  }
}
