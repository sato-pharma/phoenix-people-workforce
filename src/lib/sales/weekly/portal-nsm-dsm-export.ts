// Weekly Sales — the NSM/DSM workbook, downloaded from the PORTAL by the manager it is about.
//
// WHAT THIS IS (owner, 2026-10-17): "make national sales managers and regional managers able to
// download the dsm-nsm weekly sales, only their scope, they only choose the month in their weekly
// sales dashboard". The admin Field Sales page has carried that button since the owner reviewed the
// book on 2026-08-30, but only the three admin-shell roles open that page. This is the same
// workbook — the same builder, the same seven tabs, the same beige, password-locked design — served
// to the manager on his own portal screen.
//
// THE TWO THINGS THAT MAKE IT HIS BOOK RATHER THAN THE ADMIN ONE
// ──────────────────────────────────────────────────────────────
//  1. ONE INPUT, THE MONTH. No region, product, week, distributor or upload filter reaches it, so
//     the weekly grid always carries every week of the month and the weeks add to the month beside
//     them. (A week filter collapsed that grid to one column on the admin route and printed a month
//     total that was really one week — see the route's own comment there.) With no month named, the
//     latest uploaded cycle month is used.
//  2. HIS OWN SCOPE, THE SAME ONE HIS SCREEN SHOWS. The rows come through
//     `resolveWeeklyAccessScope` and, for a manager whose figures follow his own areas (owner,
//     2026-09-17 — own-area-share.ts), through that narrowing as well. So the book reconciles to the
//     KPI strip on the page he downloaded it from, rather than to the national total.
//
// The product AXIS still comes from the dashboard's own stable filter universe, not from the value
// present in his rows: column three must mean the same product in his book as in the national one,
// because those are the two books two people compare over the phone.

import { type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { REGION_NAMES } from "@/lib/sales/monthly-targets";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { latestUploadedPeriod } from "@/lib/sales/weekly/batch-scope";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { listMasterAreas } from "@/lib/sales/weekly/branch-region-map";
import { loadWeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import { buildNsmDsmWorkbook } from "@/lib/sales/weekly/nsm-dsm-workbook";
import { resolveWeeklyOwnAreaKeys } from "@/lib/sales/weekly/own-area-scope";
import { mayLiftWeeklyGeography } from "@/lib/sales/weekly/own-area-share";
import { loadFieldForceSeatIndex } from "@/lib/sales/weekly/portal-weekly-field-force";
import { listWeeklyBatches, loadWeeklyDashboard } from "@/lib/sales/weekly/service";

/** A cycle month as the loader stores it: the first of the month. */
const CYCLE_MONTH = /^\d{4}-\d{2}-01$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-01" → "October 2026". Falls back to the code itself rather than inventing a month. */
export function portalNsmDsmPeriodLabel(cycleMonth: string): string {
  if (!CYCLE_MONTH.test(cycleMonth)) return cycleMonth;
  const [year, month] = cycleMonth.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/**
 * Which seat the masthead names. A regional manager's book is HIS, not the national manager's, and
 * nothing else in this workbook could tell them apart: the builder's only other clue is how many
 * regions the rows span, and a regional manager's rows span several. null leaves the builder's own
 * region-count rule, which is right for a company viewer reading somebody else's scope.
 */
export function portalNsmDsmViewerSeat(role: PhoenixRole): "nsm" | "rsm" | undefined {
  if (role === "National Sales Manager") return "nsm";
  if (role === "Regional Manager") return "rsm";
  return undefined;
}

export type PortalNsmDsmExport = {
  buffer: Buffer;
  filename: string;
  /** The month the book actually covers — null only when nothing has been uploaded at all. */
  cycleMonth: string | null;
};

/**
 * Build the NSM/DSM workbook for ONE manager and ONE month, scoped to him server-side.
 *
 * `requestedMonth` is the only thing the client may choose, and the page always names one — the
 * months its Month filter holds (nsm-dsm-export-months.ts). The route REFUSES a month that is named
 * but is not a cycle month (400); it used to swap in the latest uploaded month, which exported a
 * different month from the one on screen without a word. Only an absent month falls back to the
 * latest, for a direct call to the route.
 */
export async function buildPortalNsmDsmExport(
  ctx: AccessContext,
  requestedMonth: string | null,
): Promise<PortalNsmDsmExport> {
  const accessScope = await resolveWeeklyAccessScope(ctx);
  // "Forbidden:" is the prefix every weekly route's catch turns into a 403 (isForbiddenError).
  if (accessScope.tier === "none") {
    throw new Error(`Forbidden: ${ctx.role} has no weekly sales scope to export.`);
  }

  // The month. An explicit pick wins; otherwise the latest (month, week) anyone has uploaded, taken
  // for its MONTH only — this book's whole point is the W1..Wn grid, so defaulting to the latest
  // WEEK would collapse it to one column, which is exactly what the admin route guards against.
  let cycleMonth: string | null = null;
  if (requestedMonth && CYCLE_MONTH.test(requestedMonth.trim())) {
    cycleMonth = requestedMonth.trim();
  } else {
    const validated = (await listWeeklyBatches()).filter((batch) => batch.status === "validated");
    cycleMonth = latestUploadedPeriod(validated)?.cycleMonth ?? null;
  }

  // The own-area narrowing, exactly as getPortalWeeklyMonthFieldForce sets it up: read with his
  // region bound LIFTED (depot rows still carry the region label they were mapped with) and narrow
  // straight back to his own areas, so money the split places in another manager's area leaves.
  // Both supporting indexes fail soft; without them nothing is spread and the load behaves as before.
  const seatIndex = await loadFieldForceSeatIndex();
  const areaSplitLoad = loadWeeklyAreaSplitIndex().catch(() => null);
  const ownAreaKeys = await resolveWeeklyOwnAreaKeys(ctx, accessScope, seatIndex.seats);
  const ownAreaShare = mayLiftWeeklyGeography(accessScope, ownAreaKeys)
    ? areaSplitLoad.then((areaSplit) => ({ ownAreaKeys, areaSplit, seatIndex }))
    : null;

  const [dashboard, areaSplit, managerIndex, masterAreas] = await Promise.all([
    loadWeeklyDashboard({
      accessScope,
      cycleMonths: cycleMonth ? [cycleMonth] : [],
      cycleMonthMode: "include",
      // Every week of that month, always — see the header.
      allWeeks: true,
      // MANDATORY on every weekly report and export: an unmapped SKU is the distributor's raw code
      // standing in for a real product, so the real one reads short by exactly its units.
      excludeUnmapped: true,
      includeFactRows: true,
      ownAreaShare,
      // Deliberately NOT narrowRowsToCycleMonths: the product AXIS below is read off this load's
      // option universe, which narrowing would cut down to the chosen month's own products.
    }),
    areaSplitLoad,
    loadWeeklyManagerIndex(),
    // Rows carry area CODES; the owner's rule is names, never codes.
    listMasterAreas(),
  ]);

  const rows = dashboard.factRows ?? [];
  // The lines actually present in his rows, in the rows' own spelling — so a manager on one line
  // gets that line's name on the masthead, and one covering two gets a tab set per line. Taking it
  // from the scope's line NAMES instead risked a spelling the rows do not use, which would have
  // filtered every tab away.
  const lineFilter = [...new Set(rows.map((row) => row.line.trim()).filter(Boolean))];

  const buffer = await buildNsmDsmWorkbook({
    rows,
    areaSplit,
    managerIndex,
    areaNames: new Map(masterAreas.map((area) => [area.areaCode, area.areaName])),
    regionNames: new Map(Object.entries(REGION_NAMES)),
    lineFilter,
    productAxis: (dashboard.availableProducts ?? []).map((option) => option.code),
    // No region was asked for — he asked for a month. The regions come off his own rows, and his
    // SEAT names the masthead instead of the region count.
    regionFilter: [],
    viewerSeat: portalNsmDsmViewerSeat(ctx.role),
    periodLabel: cycleMonth ? portalNsmDsmPeriodLabel(cycleMonth) : "No period",
    generatedAt: new Date().toISOString(),
  });

  return {
    buffer,
    cycleMonth,
    // Named after the month in it, so two downloads never collide in a Downloads folder.
    filename: `phoenix-weekly-nsm-dsm_${cycleMonth ? cycleMonth.slice(0, 7) : "latest-sheet"}.xlsx`,
  };
}
