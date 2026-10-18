/**
 * Customer 360 v2 — the report a page or the export reads: cached assembly, per-viewer view.
 *
 * SELF-UPDATING (owner, 2026-10-18: "make this module update itself"). Nothing about membership is
 * stored: every validated customer is read live, so one validated this morning is in the next read.
 * The heavy assembly is held for ten minutes, and every app write that can change it — a Phoenix CRM
 * validation or drop, a marketing validation or link, a request's approval or payment, a direct-order
 * venue's trust or an order's approval, an identity link, a pharmacy match, a closing published or
 * withdrawn — bumps its generation (`bumpCustomer360Cache`), so a rebuild starts on the next read. The
 * ten minutes only bound the writes this process never sees (the vendor sync, direct SQL).
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { canAccess } from "@/lib/auth/permissions";
import { CUSTOMER_360_CACHE_TTL_MS, customer360CacheGeneration } from "@/lib/cache/namespaces";
import { loadLatestValidatedPeriod, resolveRoiResultStatus, roiValueBucket, roiWindowLabel } from "@/lib/marketing-requests/roi-report-service";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { canRevealClosingSource, MASKED_SOURCE_DISTRIBUTORS, withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { loadDistributorNameIndex, UNNAMED_DISTRIBUTOR_LABEL } from "@/lib/sales/closing-details-distributor-names";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { canViewHubGeography, type CustomerVisibilityScope } from "../access";
import { assembleHubs, hubLineLabel, pairsNeedingSales, type HubAssembly } from "../hub";
import {
  buildHubViews,
  buildMatchItemViews,
  hubsWithMaskedCodes,
  withoutMaskedPharmacies,
  type ClosedMonths,
  type ClosingSalesRow,
  type HubView,
  type MatchItemView,
  type RoiContext,
} from "../report";
import type { VerdictResult } from "../verdict";
import { loadClosedMonths, loadClosingRowsForPairs } from "./sales";
import { loadCustomer360Sources } from "./sources";

type Base = {
  assembly: HubAssembly;
  /** Each hub's verdict, decided on the real rows — the same for every viewer. */
  verdicts: ReadonlyMap<string, VerdictResult>;
  distributorNames: ReadonlyMap<string, string>;
  brickNames: Record<string, string>;
  salesRows: ClosingSalesRow[];
  months: ClosedMonths;
  salesDataAsOf: string | null;
  builtAt: string;
};

const ROI: Omit<RoiContext, "salesDataAsOf"> = {
  isCommitted: (status) => roiValueBucket(status as Parameters<typeof roiValueBucket>[0]) === "approved",
  roiResult: (input) => resolveRoiResultStatus(input),
  roiWindow: (payDate, months) => roiWindowLabel(payDate, months),
};

async function buildBase(): Promise<Base> {
  const [sources, months, salesDataAsOf, distributorNames] = await Promise.all([
    loadCustomer360Sources(),
    loadClosedMonths(),
    loadLatestValidatedPeriod(getSupabaseAdmin()),
    loadDistributorNameIndex(),
  ]);
  const assembly = assembleHubs(sources);
  const salesRows = await loadClosingRowsForPairs(pairsNeedingSales(assembly), months);
  // The verdict is a conclusion, like an achievement: decided here on every row, El Qema's included,
  // BEFORE any viewer's mask — so a Super Admin and a CEO never read two answers for one doctor.
  const judged = buildHubViews({ assembly, moneyVisible: true, months, roi: { ...ROI, salesDataAsOf }, salesRows });
  const verdicts = new Map(judged.map((view) => [view.id, view.verdict]));
  return { assembly, brickNames: Object.fromEntries(sources.brickNames), builtAt: new Date().toISOString(), distributorNames, months, salesDataAsOf, salesRows, verdicts };
}

/**
 * THE COPY IS SERVED AT ONCE AND REBUILT BEHIND IT. A build reads a dozen tables and the closing
 * (about sixteen seconds on production, 2026-10-18), so a page never waits on one once a copy exists:
 * a copy from an older generation (a write landed) or past its ten minutes is served while one rebuild
 * runs behind it, and the next read has the new one. Only the very first read of a process waits.
 * Concurrent reads share the one rebuild; a failed rebuild keeps the copy it would have replaced.
 */
type Held = { base: Base; generation: number; storedAt: number };
let held: Held | null = null;
let rebuilding: Promise<Held> | null = null;

function rebuild(): Promise<Held> {
  if (!rebuilding) {
    const generation = customer360CacheGeneration();
    rebuilding = buildBase()
      .then((base) => {
        const next = { base, generation, storedAt: Date.now() };
        held = next;
        return next;
      })
      .finally(() => {
        rebuilding = null;
      });
  }
  return rebuilding;
}

async function loadBase(): Promise<{ base: Base; refreshing: boolean }> {
  const current = held;
  if (!current) return { base: (await rebuild()).base, refreshing: false };
  const fresh = current.generation === customer360CacheGeneration() && Date.now() - current.storedAt < CUSTOMER_360_CACHE_TTL_MS;
  if (fresh) return { base: current.base, refreshing: false };
  // A failed rebuild is logged by its caller's next read; the held copy keeps serving.
  rebuild().catch(() => undefined);
  return { base: current.base, refreshing: true };
}

/** Test-only: forget the held copy. */
export function _resetCustomer360ReportCache(): void {
  held = null;
  rebuilding = null;
}

export type Customer360Report = {
  hubs: HubView[];
  matchItems: MatchItemView[];
  months: ClosedMonths;
  salesDataAsOf: string | null;
  builtAt: string;
  /** True while a newer copy is being built behind this one (a write landed since it was built). */
  refreshing: boolean;
  moneyVisible: boolean;
  /** True when the viewer may decide pharmacy matches (the Super Admin alone). */
  canDecideMatches: boolean;
  /** The last three closed months, ascending — the window "selling now" is measured over. */
  lastMonths: string[];
  /** Distributor code → name, for this viewer. A distributor the viewer may not see is absent. */
  distributorNames: Record<string, string>;
  /** Brick id → brick name, for the shops the Pharmacy matches tab offers from other bricks. */
  brickNames: Record<string, string>;
};

/** The viewer's whole report: scoped to the territory, masked for El Qema, money only for marketing readers. */
export async function loadCustomer360Report(access: AccessContext): Promise<Customer360Report> {
  const [{ base, refreshing }, scope, moneyVisible, canDecideMatches] = await Promise.all([
    loadBase(),
    resolveSalesAccessScope(access),
    canAccess(access, "market_awareness", "read"),
    canAccess(access, "customer_identity", "update"),
  ]);
  const visibility: CustomerVisibilityScope = {
    allowedAreaCodes: scope.allowedAreaCodes,
    allowedLineNames: scope.allowedLineNames,
    allowedRegionNames: scope.allowedRegionNames,
    canViewAllSales: scope.canViewAllSales,
  };
  const salesRows = [...withoutMaskedSourceRows(base.salesRows, access)];
  // El Qema's codes go with its rows: a viewer who may not see that source never reads its code on a
  // linked pharmacy, never sees a shop known only by such a code (its name would be El Qema's own), and
  // never reads a verdict amount that rests partly on its rows (`src/lib/sales/closing-source-mask.ts`).
  const reveal = canRevealClosingSource(access);
  const visibleCode = (code: string) => reveal || !MASKED_SOURCE_DISTRIBUTORS.has(code.trim().toUpperCase());
  const assembly: HubAssembly = reveal ? base.assembly : withoutMaskedPharmacies(base.assembly, visibleCode);
  const hideVerdictAmounts = reveal ? undefined : hubsWithMaskedCodes(base.assembly, visibleCode);
  const distributorNames: Record<string, string> = {};
  for (const [code, name] of base.distributorNames) if (visibleCode(code)) distributorNames[code] = name || UNNAMED_DISTRIBUTOR_LABEL;
  const views = buildHubViews({
    assembly,
    hideVerdictAmounts,
    moneyVisible,
    months: base.months,
    roi: { ...ROI, salesDataAsOf: base.salesDataAsOf },
    salesRows,
    verdicts: base.verdicts,
  });
  const hubs = views.filter((hub) =>
    canViewHubGeography(
      {
        areaCode: hub.place?.areaCode ?? null,
        lines: [...new Set([...hub.validatedOnLines, ...hub.linesVisiting])].map(hubLineLabel),
        regionName: hub.place?.regionName ?? null,
      },
      visibility,
    ),
  );
  // The confirm tab crosses territories by its nature, so it is the decider's alone.
  const matchItems = canDecideMatches ? buildMatchItemViews({ items: base.assembly.matchItems, months: base.months, salesRows }) : [];
  return {
    brickNames: canDecideMatches ? base.brickNames : {},
    builtAt: base.builtAt,
    canDecideMatches,
    distributorNames,
    hubs,
    lastMonths: base.months.all.slice(-3),
    matchItems,
    moneyVisible,
    months: base.months,
    refreshing,
    salesDataAsOf: base.salesDataAsOf,
  };
}
