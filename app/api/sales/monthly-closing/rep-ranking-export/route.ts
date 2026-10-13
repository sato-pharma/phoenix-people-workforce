import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { unpublishedClosingMessage } from "@/lib/sales/closing-details-publication-gate";
import { closingFileName, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import {
  buildScopedRepRankingExport,
  isRepRankingLine,
} from "@/lib/sales/closing-rep-ranking-export";
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

    // 🔴 THE SELECTION ONLY, AND DELIBERATELY NOT THE SCREEN'S FILTER. Every other closing export
    // forwards the on-screen filter so the file cannot cover more than the screen; this one must
    // not, because the two halves of this workbook come from different reads. The ranking itself is
    // built from `loadPortalMonthlyClosing`'s matrices, which take no row filter at all, while the
    // channel carve is built from the detail rows. Narrow the rows and the Direct/Stores split
    // shrinks underneath a ranking that did not move — a workbook that disagrees with itself, with
    // nothing on it saying which half was filtered. The ranking is a line-wide arrangement of the
    // reps in one month; it covers the whole of the viewer's scope or it is not that.
    const body = (await request.json().catch(() => ({}))) as {
      line?: string | null;
      period?: string | null;
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
      filters: {},
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

    // 🔴 ANTI INFECTIVE ONLY, the same one gate the portal path asks — owner, 2026-10-13: "wire this
    // only to the anti-infective line. Leave PD and CNS as they are." Refused in plain words rather
    // than quietly handed the ordinary workbook: this button was clicked for the ranking, and a
    // different file arriving under that name is how a reader ends up quoting the wrong sheet.
    if (!isRepRankingLine(details.line)) {
      return Response.json(
        {
          error:
            `The rep ranking workbook is built for the Anti Infective line only, so it cannot be`
            + ` produced for ${details.line}. Use Export XLSX for that line's own closing workbook.`,
        },
        { status: 400 },
      );
    }

    // PUBLISHED MONTHS ONLY, and this is the one place it has to be said out loud. Super Admin,
    // SFE Manager, CEO and Finance Manager all read unpublished months everywhere else in the
    // closing — but this workbook trends over `loadPortalMonthlyClosing`, which offers published
    // months and nothing else, and answers an unpublished one with the NEWEST PUBLISHED month
    // instead. The builder drops a month that came back under a different name and then returns
    // null, so without this check an unpublished month would read as "cannot be built" rather than
    // as "not published yet". Same sentence the portal's own gate uses.
    const scopedPortal = await loadPortalMonthlyClosing({
      access,
      line: details.line,
      period: details.period,
    }).catch(() => null);
    const published = scopedPortal?.availablePeriods ?? [];
    if (!published.includes(details.period)) {
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
      availablePeriods: published,
      line: details.line,
      period: details.period,
      rows: details.rows,
    });
    if (!ranked) {
      return Response.json(
        {
          error:
            "The rep ranking workbook could not be built for this month — its closing has no seats"
            + " or no figures for the line. Export XLSX still works.",
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
        "Content-Disposition": `attachment; filename="${closingFileName({
          kind: "details",
          line: details.line,
          period: details.period,
          region: regionScopeLabel((function* () {
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
