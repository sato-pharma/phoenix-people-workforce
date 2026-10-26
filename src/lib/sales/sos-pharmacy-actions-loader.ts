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
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { loadOperationalRegionResolver } from "@/lib/sales/closing-organogram-regions";
import { closingAreaOf } from "@/lib/sales/closing-row-area";
import { loadEvenSplitCustomerKeys } from "@/lib/sales/even-split-registry";
import {
  loadMonthlyClosingDetails,
  narrowClosingDetailsToAreas,
  type ClosingDetailRow,
  type ClosingDetailsSharedReads,
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

/** What the month-pace strip is run with — see `onPaceInputsKnown`. */
export type PortalPaceInputs = { line: string; areaCodes: string[]; productCodes: string[] | null };

export async function loadPortalPharmacyActions(input: {
  access: AccessContext;
  requestedLine?: string | null;
  /**
   * Called at most once, for a Medical Rep only, the moment the month-pace strip's inputs are final
   * and before the closing reads start — his line is chosen and his areas are his territory's, which
   * is what the payload carries on every exit after that point. Lets the route run the strip beside
   * the heavy reads instead of after them (2026-10-01, "slow to transfer between page and page").
   * The route still compares these with the payload before it uses the result.
   */
  onPaceInputsKnown?: (inputs: PortalPaceInputs) => void;
}): Promise<PortalPharmacyActionsPayload> {
  const { access } = input;
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): a rep's territory is
  // resolved from his session alone — it never depends on the portal scope or on what is published —
  // so it runs beside those reads instead of after them. Awaited exactly where it was used before; a
  // viewer who leaves earlier (a refused line, no line) never awaits it, and the guard keeps that quiet.
  const territoryLoad = access.role === "Medical Rep" ? resolveTerritoryRootScope(access) : null;
  territoryLoad?.catch(() => {});
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
  let repAreaCodes: string[] | null = null;
  if (access.role === "Medical Rep") {
    const territory = await (territoryLoad ?? resolveTerritoryRootScope(access));
    if (territory.level !== "area") {
      return base(
        territory.level === "denied"
          ? territory.diagnostic.message
          : "We don't have your area on file yet. Contact HR or your admin to get your territory assigned.",
      );
    }
    // The closing loader resolves a rep's own areas with this very resolver — `sosAreaCodes` IS
    // resolveMedicalRepSosAreaCodes(access) — so the same answer is handed to every month below.
    repAreaCodes = territory.sosAreaCodes;
    areaCodes = territory.sosAreaCodes.map((code) => code.toUpperCase());
  }

  const periods = (publishedByLine.get(choice.line) ?? []).slice(0, LOOKBACK_CLOSINGS + 1);
  if (periods.length === 0) return base(`No ${choice.line} closing has been published yet.`, areaCodes);

  const cacheKey = `${viewerKey(access)}|${choice.line}|${periods.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload;

  const line = choice.line;
  const productSet = productCodes ? new Set(productCodes) : null;

  // For a rep, the strip's inputs are final from here: both exits below carry `line`, his areas (as a
  // set) and `productCodes`. Handed over before the heavy reads start, so the strip runs beside them.
  if (access.role === "Medical Rep" && areaCodes && areaCodes.length > 0) {
    input.onPaceInputsKnown?.({ line, areaCodes: [...new Set(areaCodes)].sort(), productCodes });
  }

  // READ ONCE, SHARED BY EVERY MONTH (2026-10-01, "slow to transfer between page and page"). Each
  // month's closing load used to resolve this viewer's sales scope, read the reference masters, the
  // org chart and the even-split registry, and — for a rep — resolve his own areas again: four times
  // over for one session. None of them depends on the month, so each is read once here, with exactly
  // the arguments the loader uses for itself (it is never asked for confidential products here), and
  // handed to every month. Nothing reaches a month that it would not have read on its own.
  const referencesLoad = loadSalesReferenceData({ includeCustomerBricks: false });
  const shared: ClosingDetailsSharedReads = {
    salesScope: { includeRestricted: false, scope: resolveSalesAccessScope(access, { includeRestricted: false }) },
    references: referencesLoad,
    operationalRegions: loadOperationalRegionResolver(),
    evenSplitCustomers: loadEvenSplitCustomerKeys(),
    ...(repAreaCodes ? { medicalRepAreaCodes: Promise.resolve(repAreaCodes) } : {}),
  };
  // A month may return before awaiting one of these (an out-of-scope line answers first), so none may
  // surface as an unhandled rejection. Each is still awaited — and still throws — wherever it is used.
  shared.salesScope?.scope.catch(() => {});
  referencesLoad.catch(() => {});
  shared.operationalRegions?.catch(() => {});
  shared.evenSplitCustomers?.catch(() => {});

  const loaded = await Promise.all(
    periods.map(async (period) => {
      const details = await loadMonthlyClosingDetails({
        access,
        line,
        period,
        availableLines: [line],
        availablePeriods: periods,
        unpaged: true,
        shared,
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
  // The very name masters every month above was built from — already read, not read a fifth time.
  const references = await referencesLoad;
  const brickUniverse: BrickUniverseEntry[] = (references.bricks ?? [])
    .filter((brick) => coveredAreas.has(String(brick.areaCode ?? "").trim().toUpperCase()))
    .map((brick) => ({
      brickId: brick.brickId,
      brickName: brick.brickName || brick.brickId,
      areaCode: brick.areaCode,
      areaName: brick.areaName || "",
    }));

  const areaNames = new Map<string, string>();
  for (const area of references.areas ?? []) {
    const code = String(area.areaCode ?? "").trim().toUpperCase();
    const name = String(area.areaName ?? "").trim();
    if (code && name && name.toUpperCase() !== code) areaNames.set(code, name);
  }
  const actions = buildPharmacyActions({ periods: periodRows, brickUniverse, areaNames });
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
