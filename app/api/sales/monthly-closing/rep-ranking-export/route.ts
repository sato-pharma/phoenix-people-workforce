import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  readsUnpublishedClosings,
  unpublishedClosingMessage,
} from "@/lib/sales/closing-details-publication-gate";
import { resolveClosingFileName } from "@/lib/sales/closing-export-file-name";
import {
  buildScopedRepRankingExport,
  isRepRankingLine,
} from "@/lib/sales/closing-rep-ranking-export";
import { rankingFiltersAreEmpty } from "@/lib/sales/closing-rep-ranking-filter";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import {
  isSalesPeriodReleased,
  loadSalesReleaseKeys,
  readsUnpublishedSalesTools,
} from "@/lib/sales/unpublished-sales-access";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { loadPortalMonthlyClosing } from "@/lib/sales/monthly-closing-portal";
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
} from "@/lib/sales/monthly-distributor-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE REP RANKING WORKBOOK, as a download of its own — the third export button on the admin
 * Monthly Closing screen.
 *
 * Owner, 2026-10-13, asked how to download this sheet "from admin account" and chose "add a third
 * button" over reaching it another way. The reason he could not already is that
 * /api/sales/monthly-closing/export decides by ROLE before it ever reaches its rep-ranking branch:
 * Super Admin, system scope, SFE Manager, CEO, Finance Manager and the Marketing Manager all return
 * the full six-sheet workbook higher up the file, so the ranking branch below is unreachable for
 * exactly the people who run the admin screen. That disjunction is append-only — a required test
 * pins its first three terms as a literal source substring — and the workbook it guards is frozen,
 * so this route sits BESIDE it and changes nothing about it. The portal keeps the file it got on
 * 2026-10-13; the admin screen gains the same file by asking for it by name.
 *
 * It is the SAME builder, not a second arrangement of the same figures: `buildScopedRepRankingExport`
 * is the one entry point, so a change to the ranking reaches both buttons or neither.
 *
 * SCOPE IS THE VIEWER'S OWN — "everyone his scope, not me" (owner, same day). Nothing here widens
 * anybody: the builder asks `loadPortalMonthlyClosing` for every trend month, so each month is
 * narrowed and publish-gated by the same chain that scopes that viewer's screen. For a Super Admin
 * that resolves to the whole line with no region or product bound, which is what he asked for; for a
 * Medical Rep it is still his own row.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-rep-ranking",
    });

    // 🔴 THE SCREEN'S FILTER TRAVELS WITH IT, AND IT NARROWS THE WHOLE FILE - owner,
    // 2026-10-13: "I filtered from my admin account and exported - it's supposed to follow my
    // filter. No, it did not follow my filter. All the shit is exported."
    //
    // It used to be dropped here on purpose, and the objection was real: the two halves of this
    // workbook come from different reads - the ranking from `loadPortalMonthlyClosing`'s matrices,
    // the channel carve from the detail rows - so narrowing only the rows shrinks Stores and Office
    // underneath a ranking that did not move. He was shown that and chose to have every filter
    // narrow everything, so BOTH halves now take the same filter: the rows below, and the matrices
    // inside the builder (`closing-rep-ranking-filter.ts`, which DROPS cells and never re-derives a
    // figure, so every number stays a published one). The file then says which rectangle it is, on
    // the Ranking sheet's own heading and in full on Trust.
    const body = (await request.json().catch(() => ({}))) as {
      areaCodes?: string[] | null;
      line?: string | null;
      period?: string | null;
      productCodes?: string[] | null;
      regionCodes?: string[] | null;
      search?: string | null;
    };
    const filters = {
      areaCodes: body.areaCodes ?? [],
      productCodes: body.productCodes ?? [],
      regionCodes: body.regionCodes ?? [],
      search: body.search ?? "",
    };

    const [availableLines, availablePeriods] = await Promise.all([
      listMonthlyClosingLines(),
      listMonthlyClosingPeriods(),
    ]);

    // The line and month are resolved by the SAME service that will read the rows, so the gate
    // below and the file cannot disagree about which line this is: a line outside the caller's
    // scope is reported, never swapped for one inside it.
    const details = await loadMonthlyClosingDetails({
      access,
      line: body.line ?? null,
      period: body.period ?? null,
      availableLines,
      availablePeriods,
      filters,
      unpaged: true,
    });
    if (details.outOfScope) {
      return Response.json({ error: "Forbidden: this line is outside your access." }, { status: 403 });
    }
    if (!details.line || !details.period) {
      return Response.json(
        { error: "No validated Monthly Closing data available to export." },
        { status: 400 },
      );
    }

    // 🔴 THE DRESSED LINES ONLY, through the same one gate the portal path asks — owner,
    // 2026-10-13: "wire this only to the anti-infective line. Leave PD and CNS as they are", and
    // then, the same day, "now use the CNS identity to make the new identity ranking rep closing
    // sheet ... for CNS with CNS identity". Refused in plain words rather than quietly handed the
    // ordinary workbook: this button was clicked for the ranking, and a different file arriving
    // under that name is how a reader ends up quoting the wrong sheet.
    if (!isRepRankingLine(details.line)) {
      return Response.json(
        {
          error:
            `The rep ranking workbook is built only for the lines that have an identity to wear,`
            + ` so it cannot be produced for ${details.line}. Use Export XLSX for that line's own`
            + ` closing workbook.`,
        },
        { status: 400 },
      );
    }

    // 🔴 THE MONTHS THIS READER IS OFFERED, WHICH IS NOT THE SAME QUESTION AS "PUBLISHED".
    //
    // Super Admin, SFE Manager, CEO and Finance Manager read an unpublished closing everywhere else
    // in this module, and on 2026-10-13 that stopped being academic: the owner clicked this button
    // on September and was refused, because EVERY Anti Infective month was unpublished — September
    // since 9 October, July and August since the 12th — so the workbook could not be built for any
    // month at all. Asked, he chose to have his own copy read the month his screen already reads.
    //
    // `readsUnpublishedClosings` is the ONE predicate, the same one the details gate uses and the
    // same set the closing export's full-workbook branch admits. It swaps the month list for the
    // VALIDATED months and changes nothing else: the confidential strip, the product bound and the
    // region/area narrowing all still run, so this widens WHICH MONTHS he may export and never
    // whose figures. Everyone outside that set keeps the publish gate exactly as it was — and the
    // portal export never passes the flag at all, because there the gate is the whole point.
    const readsUnpublished = readsUnpublishedClosings(access);
    const scopedPortal = await loadPortalMonthlyClosing({
      access,
      includeUnpublished: readsUnpublished,
      line: details.line,
      period: details.period,
    }).catch(() => null);
    const offered = scopedPortal?.availablePeriods ?? [];
    // A workbook is a file that travels, so only the Super Admin and the SFE Manager download one
    // before publication (owner, 2026-11-04: "close the rep ranking export until published too"). The
    // CEO, Finance and Marketing keep the older months, and every month in the file's trend is
    // published, so a published month cannot carry an unpublished one beside it.
    const lineCode = resolveTargetLineCode(details.line);
    const publishedKeys = readsUnpublishedSalesTools(access) ? null : await loadSalesReleaseKeys();
    const released = publishedKeys
      ? offered.filter((month) => isSalesPeriodReleased(month, lineCode, publishedKeys))
      : offered;
    // Refused in plain words, and FIRST. Without this the builder would answer an unpublished month
    // with "cannot be built": `loadPortalMonthlyClosing` substitutes the newest published month,
    // and the builder drops a month that came back under a different name. Same sentence the
    // portal's own gate uses.
    if (!released.includes(details.period)) {
      return Response.json(
        { error: unpublishedClosingMessage(details.line, details.period) },
        { status: 403 },
      );
    }

    // 🔴 THE UNMASKED ROWS, as the portal path passes them. They are what the published cells were
    // built from, so the warehouse carve adds back to exactly those cells; the masked set has rows
    // REMOVED, which would understate the store channel against the very figure it is carved out
    // of. Nothing identifying survives the carve — money per area × product and one count of
    // distinct warehouse customers, never a customer name or code.
    const ranked = await buildScopedRepRankingExport({
      access,
      availablePeriods: released,
      includeUnpublished: readsUnpublished,
      filters,
      line: details.line,
      period: details.period,
      rows: details.rows,
    });
    if (!ranked) {
      return Response.json(
        {
          error:
            rankingFiltersAreEmpty(filters)
              ? `The rep ranking workbook could not be built for this month — the ${details.line}`
                + " closing has no rows, no seats or no figures for it. Export XLSX still works."
              // The commonest reason a FILTERED export comes back empty, said plainly instead of
              // the no-data sentence: the filter, not the month, is what left nothing to rank.
              : `The rep ranking workbook could not be built — your filter leaves no ${details.line}`
                + " seat with any figure in it. Widen it, or clear it to export the whole line.",
        },
        { status: 409 },
      );
    }

    // Named exactly as the portal's own download of this same workbook, because it IS the same
    // file: two names for one workbook is how two people compare figures and conclude they are
    // looking at different reports.
    return new Response(new Uint8Array(ranked.buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${await resolveClosingFileName({
          kind: "details",
          line: details.line,
          period: details.period,
          regionNames: ((function* () {
            for (const row of details.rows) {
              yield row.operationalRegionName || row.regionName;
            }
          })()),
        })}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
