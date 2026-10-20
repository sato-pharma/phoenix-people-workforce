import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { trustedOriginForRedirect } from "@/lib/security/origins";
import {
  MARKETING_OVERSIGHT_LINE_ROLES,
  canViewHeadOfficeLine,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { fillClosingEngine } from "@/lib/sales/closing-engine-fill";
import { resolveClosingFileName } from "@/lib/sales/closing-export-file-name";
import { buildClosingNoOfficeSheet } from "@/lib/sales/closing-no-office-sheet";
import { loadClosingExportPayload } from "@/lib/sales/closing-export-payload";
import { sealClosingSelection, sealedRepCardPdfBase } from "@/lib/sales/closing-pdf-link-seal";
import { loadClosingQuarterGap } from "@/lib/sales/closing-quarter-gap";
import { buildQuarterGapSheet, canSeeQuarterGapTab } from "@/lib/sales/closing-quarter-gap-sheet";
import { buildClosingRowsSheet } from "@/lib/sales/closing-rows-sheet";
import { loadDistributorNameIndex } from "@/lib/sales/closing-details-distributor-names";
import { buildReviewSheets, closingSheetMonthLabel } from "@/lib/sales/closing-review-sheets";
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

    // Read ONCE and shared. The quarter tab below narrows its own months with this same object, and
    // a second reading of the same body is where a filtered workbook ends up with one tab narrowed
    // and another not -- which reads as a disagreement between the numbers rather than as a filter.
    const filter = {
      areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
      productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
      regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
      search: typeof body.search === "string" ? body.search : "",
    };

    // Loaded by the shared module, not inline. The PDF renderer is the third reader of this same
    // month, and every branch of the load is a wrong NUMBER rather than an error when it is got
    // wrong -- a prior matrix for the wrong month, a details loader silently handed no line. Three
    // copies is where those drift; see `closing-export-payload.ts` for the traps it carries.
    const payload = await loadClosingExportPayload({
      access,
      filter,
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
    //
    // It canNOT be `new URL(request.url).origin`, which is what shipped: behind Railway's proxy
    // that is the container's OWN bind address, so every Export PDF link in a downloaded workbook
    // came out as `https://0.0.0.0:8080/…` and opened nothing. Both share feeds hit this exact bug
    // first and each answered it with a hard-coded production URL — affordable there because each
    // has exactly one consumer, and NOT affordable here, because the staging workbook has to keep
    // pointing at staging. `trustedOriginForRedirect` answers both halves at once: it reads
    // `x-forwarded-host`, so it resolves the real public domain, but honours it only when it is
    // already an allowed Phoenix origin — so a caller's header cannot aim the owner's links at a
    // host we do not serve. Both environments carry their own URL in `PHOENIX_ALLOWED_ORIGINS`, and
    // anything unrecognised falls back to the production domain rather than to a dead one.
    const origin = trustedOriginForRedirect(request);

    // THE SEAL — owner, 2026-09-14: "any one who receive the closing can export". The workbook is
    // forwarded to managers and reps whose own scope is narrower than the file, and each of them was
    // refused by the PDF route's company-wide gate. So every Export PDF link carries a seal of the
    // selection this workbook was built from, and the PDF route reads the line, month and filters out
    // of the seal instead of off the URL — editing the link reaches nothing the file does not hold.
    // `headOffice` records whether the downloader sees Head Office's detail rows, so the PDF shows
    // what the file shows. Null without a signing secret; the links then go out bare, as before.
    const seal = sealClosingSelection({
      filter,
      headOffice: canViewHeadOfficeLine(access.role),
      line: payload.line,
      period: payload.period,
    });

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
      // The readable parameters above stay so a link reads as what it is; the PDF route ignores them
      // whenever this seal is valid.
      if (seal) query.set("seal", seal);
      return `${origin}/api/sales/monthly-closing/premium-export/pdf?${query.toString()}`;
    };

    // The Rep Card's link is a FORMULA, not a shape: the sheet draws whichever rep its dropdown is
    // set to, and only a formula can append that choice to the URL when the sheet recalculates.
    // Sealed, it drops the readable line and month — Excel caps a formula's link at 255 characters and
    // the seal already carries both. A selection too long to fit even then keeps the unsealed base.
    const repCardPdfBase = (seal ? sealedRepCardPdfBase(origin, seal) : null)
      ?? `${origin}/api/sales/monthly-closing/premium-export/pdf?${new URLSearchParams({
        ...(payload.line ? { line: payload.line } : {}),
        ...(payload.period ? { period: payload.period } : {}),
        sheet: "Rep Card",
      }).toString()}`;

    // The Performance Review folded in as extra sheets, at the owner's instruction (2026-09-05):
    // one workbook instead of two. Only what the engine does not already carry -- the review's own
    // Rep Ranking and Family Performance would collide with the sheets of those names already here.
    const reviewSheets = buildReviewSheets(payload.review, { line: payload.line, period: payload.period });

    // The quarter behind the month, for the OWNER'S copy of this workbook only -- owner,
    // 2026-09-10, "make it only in super admin export". The gate is asked here, before the read,
    // so a caller who will not receive the tab does not pay for the two extra months either.
    //
    // Loaded HERE and not in `closing-export-payload.ts`, which exists so the three readers of one
    // MONTH cannot drift: this is a quarter, it has exactly one reader, and the PDF renderer shares
    // that payload and would pay for a read it never renders.
    //
    // `payload.matrix` goes in so the selected month is not read a second time, and so this sheet's
    // figure for it is the identical object every other tab in the workbook was built from. A month
    // with no targets, a line that carries none, or a failed targets read all return null, and the
    // tab is then simply absent rather than showing a gap measured against a target that is missing.
    const quarterGap = canSeeQuarterGapTab(access)
      ? await loadClosingQuarterGap({
        filter,
        line: payload.line,
        period: payload.period,
        selectedMonth: payload.matrix,
      })
      : null;
    const quarterGapSheet = buildQuarterGapSheet(quarterGap, { line: payload.line, period: payload.period });

    // 🔴 THE CLOSING MATRIX WITHOUT THE OFFICE CHANNEL, as the tab straight after it — owner,
    // 2026-10-05: "only in CNS ... a new tab is added without the office sales ... in the premium
    // and in the normal xlsx monthly closing." Null on every other line, because Office is CNS-only,
    // so no other workbook gains a tab that would be a copy of the grid it already has.
    //
    // It reads the payload's own Office slice, narrowed by the SAME filter as `payload.matrix`, so a
    // filtered workbook's twin covers exactly the slice the rest of the file does. This route has no
    // ROW-LEVEL filter, which is the one case where the two grids cannot be subtracted at all.
    const noOfficeSheet = buildClosingNoOfficeSheet(payload.matrix, payload.office, {
      filterNote: payload.filterNote,
    });

    // 🔴 EVERY COUNTED ROW, AT INVOICE GRAIN — owner, 2026-10-13: "put the Rows tab in the premium
    // closing download and in the ranking." The engine's own `Data` sheet is one row per area x
    // product, so until now no download in the system reached invoice grain at all; the only place
    // that did was the Details screen, which has no download button.
    //
    // It reads `payload.details` — the SAME rows the engine's Data/Total bridge was built from, not
    // a second read of the month — so the total at the foot of the tab is the Closing tab's own
    // figure by construction. The distributor names come from the master the Details screen uses,
    // because the owner's standing rule is names, never codes.
    // Never throws — it answers a failed read with an empty index, and the tab then falls back to
    // "Unnamed distributor" rather than taking the whole download down for a label.
    const distributorNames = await loadDistributorNameIndex();
    const rowsSheet = buildClosingRowsSheet({
      distributorNames,
      filterNote: payload.filterNote,
      line: payload.line,
      periodLabel: payload.period ? closingSheetMonthLabel(payload.period) : null,
      rows: payload.details ?? [],
    });

    const appendedSheets = [
      ...reviewSheets,
      ...(quarterGapSheet ? [quarterGapSheet] : []),
      ...(noOfficeSheet ? [noOfficeSheet] : []),
      ...(rowsSheet ? [rowsSheet] : []),
    ];

    const buffer = await fillClosingEngine(payload.fill, {
      macroFree: !macros,
      reviewSheets: appendedSheets,
      ...(macros ? {} : { pdfLink, repCardPdfBase }),
    });
    const fileName = await resolveClosingFileName({
      extension: macros ? "xlsm" : "xlsx",
      kind: "premium",
      line: payload.line,
      period: payload.period,
      regionNames: (payload.matrix.regions.map((region) => region.regionName)),
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
