// Loads the pharmacy action lists for one portal viewer. The rules live in sos-pharmacy-actions.ts
// (pure); this file only decides WHICH rows reach them.
//
// 🔴 PUBLISHED MONTHS ONLY. Monthly Closing is the only sales truth, and an unpublished month is not
// one yet — so the window is the newest published closings for the line, read through
// loadMonthlyClosingDetails, the one pharmacy-level source that reconciles to the closing.
//
// 🔴 NEVER `revealSource`. El Qema stays Main Stores for every portal viewer; the pure module keeps
// Main Stores out of the lists. tests/closing-source-mask.test.ts fences who may pass that flag.
//
// 🔴 A MEDICAL REP SEES HIS OWN AREA, not his region. The sales access scope for a rep is SELF, which
// the closing loader reads at region level — so the rep is narrowed here, after the load, to the
// areas the Territory Drilldown resolves for him. Narrowing after the load (never before) is what
// keeps every city-split share identical to the closing's own figure: see narrowClosingDetailsToAreas.

import type { AccessContext } from "@/lib/auth/permissions";
import { closingAreaOf } from "@/lib/sales/closing-row-area";
import {
  loadMonthlyClosingDetails,
  narrowClosingDetailsToAreas,
  type ClosingDetailRow,
} from "@/lib/sales/monthly-closing-details";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { pickPortalClosingLine, resolvePortalClosingScope } from "@/lib/sales/monthly-closing-portal";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  buildPharmacyActions,
  LOOKBACK_CLOSINGS,
  type BrickUniverseEntry,
  type PharmacyActionsResult,
} from "@/lib/sales/sos-pharmacy-actions";
import { resolveTerritoryRootScope } from "@/lib/sales/territory/root-scope";

export type PortalPharmacyActionsPayload = {
  line: string | null;
  /** Lines the viewer may pick between (published only). One entry for nearly everyone. */
  availableLines: string[];
  actions: PharmacyActionsResult | null;
  /** Plain-words reason there is nothing to show. null when `actions` is set. */
  message: string | null;
  /** The viewer's own area bound, for the month-pace strip. null = no area narrowing. */
  areaCodes: string[] | null;
  /** The viewer's product bound (Product / Group Product Manager). null = the whole line. */
  productCodes: string[] | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; payload: PortalPharmacyActionsPayload }>();

function viewerKey(access: AccessContext): string {
  return `${access.role}|${String(access.hrId ?? access.loginId ?? "").trim().toUpperCase()}`;
}

function remember(key: string, payload: PortalPharmacyActionsPayload): PortalPharmacyActionsPayload {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), payload });
  return payload;
}

export async function loadPortalPharmacyActions(input: {
  access: AccessContext;
  requestedLine?: string | null;
}): Promise<PortalPharmacyActionsPayload> {
  const { access } = input;
  const scope = await resolvePortalClosingScope(access);

  // Which lines have anything published. At most three (the Marketing oversight set).
  const publishedByLine = new Map<string, string[]>();
  await Promise.all(
    scope.allowedLines.map(async (candidate) => {
      publishedByLine.set(candidate, await listPublishedPeriodsForLine(candidate));
    }),
  );
  const choice = pickPortalClosingLine({
    requestedLine: input.requestedLine,
    allowedLines: scope.allowedLines,
    publishedLines: scope.allowedLines.filter((candidate) => (publishedByLine.get(candidate) ?? []).length > 0),
  });
  const productCodes = scope.productCodes ? [...scope.productCodes].map((code) => code.toUpperCase()) : null;

  const base = (message: string, areaCodes: string[] | null = null): PortalPharmacyActionsPayload => ({
    line: choice.line,
    availableLines: choice.availableLines,
    actions: null,
    message,
    areaCodes,
    productCodes,
  });

  if (choice.refused) return base("That line is outside your scope.");
  if (!choice.line) return base("We couldn't determine your product line. Contact HR or your admin.");

  let areaCodes: string[] | null = scope.areaCodes && scope.areaCodes.size > 0
    ? [...scope.areaCodes].map((code) => code.toUpperCase())
    : null;
  if (access.role === "Medical Rep") {
    const territory = await resolveTerritoryRootScope(access);
    if (territory.level !== "area") {
      return base(
        territory.level === "denied"
          ? territory.diagnostic.message
          : "We don't have your area on file yet. Contact HR or your admin to get your territory assigned.",
      );
    }
    areaCodes = territory.sosAreaCodes.map((code) => code.toUpperCase());
  }

  const periods = (publishedByLine.get(choice.line) ?? []).slice(0, LOOKBACK_CLOSINGS + 1);
  if (periods.length === 0) return base(`No ${choice.line} closing has been published yet.`, areaCodes);

  const cacheKey = `${viewerKey(access)}|${choice.line}|${periods.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload;

  const line = choice.line;
  const productSet = productCodes ? new Set(productCodes) : null;
  const loaded = await Promise.all(
    periods.map(async (period) => {
      const details = await loadMonthlyClosingDetails({
        access,
        line,
        period,
        availableLines: [line],
        availablePeriods: periods,
        unpaged: true,
      });
      if (details.outOfScope) return null;
      const narrowed = areaCodes ? narrowClosingDetailsToAreas(details, areaCodes) : details;
      const rows: ClosingDetailRow[] = productSet
        ? narrowed.rows.filter((row) => productSet.has(row.productCode.toUpperCase()))
        : narrowed.rows;
      return { period, rows };
    }),
  );
  if (loaded.some((entry) => entry === null)) return base("This line is outside your scope.", areaCodes);
  const periodRows = loaded.filter((entry): entry is { period: string; rows: ClosingDetailRow[] } => entry !== null);

  // The bricks the viewer covers: their own areas when bound, otherwise every area their rows reach.
  const coveredAreas = new Set(
    areaCodes ?? periodRows.flatMap((entry) => entry.rows.map((row) => closingAreaOf(row))).filter(Boolean),
  );
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickUniverse: BrickUniverseEntry[] = (references.bricks ?? [])
    .filter((brick) => coveredAreas.has(String(brick.areaCode ?? "").trim().toUpperCase()))
    .map((brick) => ({
      brickId: brick.brickId,
      brickName: brick.brickName || brick.brickId,
      areaCode: brick.areaCode,
      areaName: brick.areaName || brick.areaCode,
    }));

  const actions = buildPharmacyActions({ periods: periodRows, brickUniverse });
  return remember(cacheKey, {
    line,
    availableLines: choice.availableLines,
    actions,
    message: null,
    // Always the areas the viewer COVERS, never null once rows loaded: a District Manager whose seat
    // did not resolve is region-bound in the closing but line-bound in Sales vs Target, and the pace
    // strip would otherwise measure his region's weekly sales against the whole line's target.
    areaCodes: [...coveredAreas].sort(),
    productCodes,
  });
}
