import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { addDays, formatPlainDateIso, parsePlainDate, todayInCairo } from "@/lib/milestones/periods";
import {
  buildMilestonePrintHistoryWorkbook,
  milestonePrintHistoryFileName,
} from "@/lib/milestones/print-history-export";
import { getMilestonePrintHistory } from "@/lib/milestones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The default look-back for the print history: the last quarter of print dates. */
const HISTORY_DEFAULT_DAYS = 90;

/**
 * The milestone print history — who was congratulated, with which card, when, by whom.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:read`, the Super Admin alone (the owner narrowed the whole module on
 * 2026-09-23). THE GATE IS HERE, not in the sidebar. The route reads the append-only print log — a
 * record, not a control — so there is no scope narrowing to do; it is Super Admin's log to read.
 *
 * `from`/`to` are print DATES (`YYYY-MM-DD`), defaulting to the last 90 days through today in Cairo.
 * `format=xlsx` returns the same rows as a workbook; anything else returns JSON for the on-page view.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "milestones", "read");

    const url = new URL(request.url);
    const today = todayInCairo();
    const from = parsePlainDate(url.searchParams.get("from")) ?? addDays(today, -HISTORY_DEFAULT_DAYS);
    const to = parsePlainDate(url.searchParams.get("to")) ?? today;
    const fromIso = formatPlainDateIso(from);
    const toIso = formatPlainDateIso(to);

    const entries = await getMilestonePrintHistory({ fromIso, toIso });

    if (url.searchParams.get("format") === "xlsx") {
      const workbook = await buildMilestonePrintHistoryWorkbook(entries);
      return new Response(new Uint8Array(workbook), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${milestonePrintHistoryFileName(fromIso, toIso)}"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    }

    return Response.json({ from: fromIso, to: toIso, entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "The milestone print history is available to the system administrator only." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The milestone print history could not be read.") },
      { status: 500 },
    );
  }
}
