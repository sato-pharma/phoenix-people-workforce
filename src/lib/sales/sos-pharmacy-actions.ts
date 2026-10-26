// ─────────────────────────────────────────────────────────────────────────────
// PHARMACY ACTIONS — "where my sales come from, and what to do about it".
//
// Owner, 2026-09-14: the portal Source of Sales page "is irrelevant, nobody uses it because it is
// showing data that will not benefit them". What a rep or a manager can act on is a PHARMACY: one
// that stopped buying, one that is sliding, one that just started, one that buys half the line.
// Nothing in src/lib computed any of that, so this module does — and only this.
//
// PURE. No IO, no AccessContext. The loader (sos-pharmacy-actions-loader.ts) reads published Monthly
// Closing detail rows that are already scoped to the viewer and hands them here, which is what lets
// every rule below be unit-tested from fixtures (tests/sos-pharmacy-actions.test.ts).
//
// THE RULES, each the owner's own pick (multiple choice, 2026-09-14):
//   · STOPPED  — bought in ANY of the 3 closings before the latest, and nothing in the latest.
//   · DROPPING — the latest closing is 30% or more below the average of the 3 before it.
//   · NEW      — bought in the latest closing and in none of the 3 before it.
//
// 🔴 VALUE ONLY. Units of different products are never added (owner rule), so every figure a
// pharmacy carries here is EGP. A unit total is never produced.
//
// 🔴 WHAT IS NOT A PHARMACY, and is kept out of every list but still shown as a total so the page
// ties to the closing:
//   · Main Stores rows — an area's share of El Qema's warehouses. No buyer to name or visit.
//   · El Qema's real rows (only a Super Admin loads them) — the same money, unmasked.
//   · a wholesaler's city-split SHARE — the closing spreads a wholesaler across its city's areas, so
//     the same store appears in several areas with fractional units. Chasing it in each area is
//     chasing one account several times, and its "drop" in one area is the split, not the buyer.
//   · rows with no customer code — nothing to identify across months.
// ─────────────────────────────────────────────────────────────────────────────

import { MAIN_STORES_LABEL } from "@/lib/sales/closing-main-stores";
import { closingAreaOf, type ClosingAreaRow } from "@/lib/sales/closing-row-area";
import { MASKED_SOURCE_DISTRIBUTORS } from "@/lib/sales/closing-source-mask";

/** The fields a closing detail row must carry. Structural, so ClosingDetailRow satisfies it as-is. */
export type PharmacyActionRow = ClosingAreaRow & {
  distributorCode: string;
  clientCode: string;
  clientName: string;
  clientAddress: string;
  areaName: string;
  sheetAreaName?: string;
  brickId: string;
  brickName: string;
  productCode: string;
  productName: string;
  salesValue: number;
  effectiveUnits: number;
  isDirect: boolean;
  evenSplitApplied: boolean;
};

/** One published closing's rows. */
export type PeriodRows = { period: string; rows: readonly PharmacyActionRow[] };

/** A brick the viewer covers, for the untapped-brick list. Names only reach the screen. */
export type BrickUniverseEntry = { brickId: string; brickName: string; areaCode: string; areaName: string };

/** How many closings before the latest the stopped / dropping / new rules look back over. */
export const LOOKBACK_CLOSINGS = 3;
/** Latest at or below this fraction of the look-back average is "dropping" (30%+ below). */
export const DROPPING_RATIO = 0.7;
/** A product is "core" to the viewer's book when at least this share of active pharmacies buy it. */
export const CORE_PRODUCT_BUYER_SHARE = 0.4;
/** Below this many active pharmacies a "core product" says nothing, so no cross-sell list is built. */
export const CORE_PRODUCT_MIN_PHARMACIES = 5;
export const CORE_PRODUCT_MAX = 8;
/** Per list. Generous on purpose: the screen filters by area client-side, and a small cap would hide an area. */
export const ACTION_LIST_LIMIT = 200;
export const TOP_PHARMACY_LIMIT = 10;

export type PharmacyRowKind = "pharmacy" | "mainStores" | "wholesalerShare" | "noCode";

export type PharmacyActionItem = {
  /** Stable React key. Never rendered. */
  key: string;
  name: string;
  address: string;
  areaCode: string;
  areaName: string;
  brickName: string;
  /** Bought through a direct order (DirectReq) rather than a distributor. */
  isDirect: boolean;
  /** EGP in the latest closing. */
  latestValue: number;
  /** EGP average over the look-back closings (zeros count — a month with no purchase is a zero). */
  priorAverage: number;
  /** latest vs the look-back average, as a fraction (-0.42 = 42% below). null when there is no average. */
  change: number | null;
  /** Newest closing this pharmacy bought in, within the window. */
  lastBoughtPeriod: string | null;
  /** How many of the loaded closings it bought in. */
  closingsBought: number;
  /** Share of the viewer's pharmacy value in the latest closing. Set on the top list only. */
  share: number | null;
};

export type CrossSellItem = PharmacyActionItem & {
  missingProducts: { code: string; name: string }[];
};

type LatestTotals = {
  total: number;
  pharmacies: number;
  mainStores: number;
  wholesalerShares: number;
  noCustomerCode: number;
};

/**
 * The same figures as the whole result, for ONE area. The screen's area picker reads these, never a
 * sum over the lists: the lists are capped (ACTION_LIST_LIMIT, TOP_PHARMACY_LIMIT), so money filtered
 * out of them undercounts, and a tile would show one area's count beside every area's money.
 * A pharmacy counts in the area of its identity (newest month, biggest row) — the area its list row
 * shows — so the counts, the money and the lists always agree. Main Stores, wholesaler shares and
 * code-less rows go by the row's own area.
 */
export type PharmacyAreaSummary = {
  counts: PharmacyActionsResult["counts"];
  valueAtStake: PharmacyActionsResult["valueAtStake"];
  latestTotals: LatestTotals;
  /**
   * This area's own lists, each capped at ACTION_LIST_LIMIT / TOP_PHARMACY_LIMIT the same way the
   * whole result is — but filtered to the area BEFORE the cap, never after: the whole result's lists
   * are capped globally, so filtering one of those to an area after the fact can drop rows the tile's
   * own (uncapped) count still includes. share on "top" is of this area's pharmacy value.
   */
  stopped: PharmacyActionItem[];
  dropping: PharmacyActionItem[];
  newPharmacies: PharmacyActionItem[];
  top: PharmacyActionItem[];
  crossSell: CrossSellItem[];
  untappedBricks: BrickUniverseEntry[];
};

export type PharmacyActionsResult = {
  latestPeriod: string | null;
  /** The look-back closings actually available, newest first. */
  priorPeriods: string[];
  /** False when fewer than LOOKBACK_CLOSINGS earlier closings are published — "new" is then soft. */
  historyComplete: boolean;
  counts: {
    activePharmacies: number;
    stopped: number;
    dropping: number;
    newPharmacies: number;
    crossSell: number;
    untappedBricks: number;
  };
  /** EGP a month the lists represent. */
  valueAtStake: { stopped: number; dropping: number; newPharmacies: number };
  /** The latest closing, split so the lists visibly tie back to the whole. */
  latestTotals: LatestTotals;
  coreProducts: { code: string; name: string; buyers: number }[];
  stopped: PharmacyActionItem[];
  dropping: PharmacyActionItem[];
  newPharmacies: PharmacyActionItem[];
  top: PharmacyActionItem[];
  crossSell: CrossSellItem[];
  untappedBricks: BrickUniverseEntry[];
  /** Every area any list names, for the screen's area filter. */
  areas: { code: string; name: string }[];
  /** Per-area figures, keyed by area code. An area missing here has nothing in the latest closing or the lists. */
  byArea: Record<string, PharmacyAreaSummary>;
};

const EPSILON = 1e-6;

const text = (value: unknown): string => String(value ?? "").trim();
const upper = (value: unknown): string => text(value).toUpperCase();
const money = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function pharmacyKeyOf(row: Pick<PharmacyActionRow, "distributorCode" | "clientCode">): string {
  return `${upper(row.distributorCode)}|${upper(row.clientCode)}`;
}

function isDirectRow(row: PharmacyActionRow): boolean {
  return row.isDirect === true || upper(row.distributorCode) === "DIRECTREQ";
}

function isMainStoresRow(row: PharmacyActionRow): boolean {
  if (MASKED_SOURCE_DISTRIBUTORS.has(upper(row.distributorCode))) return true;
  return !text(row.clientCode) && text(row.clientName) === MAIN_STORES_LABEL;
}

/**
 * Customers the closing SHARES across areas, per the rows themselves.
 *
 * The credited view keeps the wholesaler's own code on each share and does not flag the row, so a
 * share is recognised by what the split leaves behind: the same customer in more than one closing
 * area in one month, units the split made fractional, or the even-split registry's stamp. A viewer
 * scoped to one area may see only one share, which is why the fractional-units and registry signals
 * are read too, and why the set is built across EVERY loaded month — once a customer is shared, it is
 * treated as a wholesaler in all of them.
 */
export function findSharedCustomerKeys(periods: readonly PeriodRows[]): Set<string> {
  const shared = new Set<string>();
  for (const { rows } of periods) {
    const areasByKey = new Map<string, Set<string>>();
    for (const row of rows) {
      // A direct order is the pharmacy's own purchase at its own area — never a city split.
      if (!text(row.clientCode) || isMainStoresRow(row) || isDirectRow(row)) continue;
      const key = pharmacyKeyOf(row);
      const units = money(row.effectiveUnits);
      if (row.evenSplitApplied || Math.abs(units - Math.round(units)) > EPSILON) shared.add(key);
      const areas = areasByKey.get(key) ?? new Set<string>();
      const area = closingAreaOf(row);
      if (area) areas.add(area);
      areasByKey.set(key, areas);
    }
    for (const [key, areas] of areasByKey) if (areas.size > 1) shared.add(key);
  }
  return shared;
}

export function classifyRowKind(row: PharmacyActionRow, sharedKeys: ReadonlySet<string>): PharmacyRowKind {
  if (isMainStoresRow(row)) return "mainStores";
  if (!text(row.clientCode)) return "noCode";
  if (sharedKeys.has(pharmacyKeyOf(row))) return "wholesalerShare";
  return "pharmacy";
}

type PharmacyAggregate = {
  key: string;
  name: string;
  address: string;
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  isDirect: boolean;
  /** Value of the row the identity above was taken from, so the biggest row of the newest month wins. */
  identityPeriod: string;
  identityValue: number;
  valueByPeriod: Map<string, number>;
  productsByPeriod: Map<string, Set<string>>;
};

function areaNameOf(row: PharmacyActionRow): string {
  // A re-booked row names its closing area on the sheet; the brick's area name would be the other one.
  const closing = closingAreaOf(row);
  if (upper(row.sheetAreaCode) === closing && text(row.sheetAreaName)) return text(row.sheetAreaName);
  return text(row.areaName) || text(row.sheetAreaName);
}

/**
 * Build every action list from published closings, NEWEST FIRST. `periods[0]` is the latest closing;
 * the next LOOKBACK_CLOSINGS are the look-back. Anything further back is ignored.
 */
export function buildPharmacyActions(input: {
  periods: readonly PeriodRows[];
  brickUniverse?: readonly BrickUniverseEntry[];
  /**
   * The area master's names by area code. A closing row whose own area name is empty used to show the
   * bare code (D12, GZ1, UE2) in the area picker and on its list row; the master's name stands in.
   */
  areaNames?: ReadonlyMap<string, string>;
}): PharmacyActionsResult {
  const masterAreaName = (areaCode: string): string => text(input.areaNames?.get(upper(areaCode)));
  // A name is real only when it is not the code written again; an empty or code-only name falls back
  // to the master, and to the code itself only when the master has nothing either.
  const areaLabel = (areaCode: string, name: string): string => {
    const own = text(name);
    if (own && upper(own) !== upper(areaCode)) return own;
    return masterAreaName(areaCode) || own || areaCode;
  };
  const ordered = [...input.periods]
    .filter((entry) => /^\d{4}-\d{2}$/.test(text(entry.period)))
    .sort((left, right) => right.period.localeCompare(left.period))
    .slice(0, LOOKBACK_CLOSINGS + 1);
  const latestPeriod = ordered[0]?.period ?? null;
  const priorPeriods = ordered.slice(1).map((entry) => entry.period);
  const windowPeriods = ordered.map((entry) => entry.period);

  const sharedKeys = findSharedCustomerKeys(ordered);
  const latestTotals: LatestTotals = { total: 0, pharmacies: 0, mainStores: 0, wholesalerShares: 0, noCustomerCode: 0 };
  // Non-pharmacy latest-closing money by the row's own area (pharmacy money is added per identity below).
  const otherTotalsByArea = new Map<string, LatestTotals>();
  const pharmacies = new Map<string, PharmacyAggregate>();
  const productNames = new Map<string, string>();
  const bricksWithSales = new Set<string>();

  for (const { period, rows } of ordered) {
    const isLatest = period === latestPeriod;
    for (const row of rows) {
      const value = money(row.salesValue);
      const kind = classifyRowKind(row, sharedKeys);
      if (isLatest) {
        latestTotals.total += value;
        if (kind === "pharmacy") latestTotals.pharmacies += value;
        else if (kind === "mainStores") latestTotals.mainStores += value;
        else if (kind === "wholesalerShare") latestTotals.wholesalerShares += value;
        else latestTotals.noCustomerCode += value;
        if (kind !== "pharmacy") {
          const areaCode = closingAreaOf(row);
          if (areaCode) {
            const bucket = otherTotalsByArea.get(areaCode) ?? { total: 0, pharmacies: 0, mainStores: 0, wholesalerShares: 0, noCustomerCode: 0 };
            bucket.total += value;
            if (kind === "mainStores") bucket.mainStores += value;
            else if (kind === "wholesalerShare") bucket.wholesalerShares += value;
            else bucket.noCustomerCode += value;
            otherTotalsByArea.set(areaCode, bucket);
          }
        }
      }
      if (kind !== "pharmacy") continue;
      if (value > EPSILON && text(row.brickId)) bricksWithSales.add(upper(row.brickId));

      const key = pharmacyKeyOf(row);
      const existing = pharmacies.get(key);
      const aggregate: PharmacyAggregate = existing ?? {
        key,
        name: text(row.clientName),
        address: text(row.clientAddress),
        areaCode: closingAreaOf(row),
        areaName: areaNameOf(row),
        brickId: upper(row.brickId),
        brickName: text(row.brickName),
        isDirect: isDirectRow(row),
        identityPeriod: period,
        identityValue: value,
        valueByPeriod: new Map(),
        productsByPeriod: new Map(),
      };
      // Identity follows the newest month, and inside it the biggest row: a renamed pharmacy shows its
      // current name, and a pharmacy that moved area shows where it buys now.
      const newer = period > aggregate.identityPeriod;
      if (existing && (newer || (period === aggregate.identityPeriod && value > aggregate.identityValue))) {
        aggregate.name = text(row.clientName) || aggregate.name;
        aggregate.address = text(row.clientAddress) || aggregate.address;
        aggregate.areaCode = closingAreaOf(row) || aggregate.areaCode;
        aggregate.areaName = areaNameOf(row) || aggregate.areaName;
        aggregate.brickId = upper(row.brickId) || aggregate.brickId;
        aggregate.brickName = text(row.brickName) || aggregate.brickName;
        aggregate.identityPeriod = period;
        aggregate.identityValue = value;
      }
      aggregate.valueByPeriod.set(period, (aggregate.valueByPeriod.get(period) ?? 0) + value);
      if (value > EPSILON && text(row.productCode)) {
        const code = upper(row.productCode);
        const bought = aggregate.productsByPeriod.get(period) ?? new Set<string>();
        bought.add(code);
        aggregate.productsByPeriod.set(period, bought);
        if (!productNames.has(code)) productNames.set(code, text(row.productName) || code);
      }
      pharmacies.set(key, aggregate);
    }
  }

  const itemOf = (aggregate: PharmacyAggregate): PharmacyActionItem => {
    const latestValue = latestPeriod ? aggregate.valueByPeriod.get(latestPeriod) ?? 0 : 0;
    const priorSum = priorPeriods.reduce((sum, period) => sum + (aggregate.valueByPeriod.get(period) ?? 0), 0);
    const priorAverage = priorPeriods.length > 0 ? priorSum / priorPeriods.length : 0;
    const boughtIn = windowPeriods.filter((period) => (aggregate.valueByPeriod.get(period) ?? 0) > EPSILON);
    return {
      key: aggregate.key,
      name: aggregate.name,
      address: aggregate.address,
      areaCode: aggregate.areaCode,
      areaName: areaLabel(aggregate.areaCode, aggregate.areaName),
      brickName: aggregate.brickName,
      isDirect: aggregate.isDirect,
      latestValue: round2(latestValue),
      priorAverage: round2(priorAverage),
      change: priorAverage > EPSILON ? (latestValue - priorAverage) / priorAverage : null,
      lastBoughtPeriod: boughtIn[0] ?? null,
      closingsBought: boughtIn.length,
      share: null,
    };
  };

  const items = [...pharmacies.values()].map((aggregate) => ({ aggregate, item: itemOf(aggregate) }));
  const priorValueOf = (aggregate: PharmacyAggregate) =>
    priorPeriods.reduce((sum, period) => sum + (aggregate.valueByPeriod.get(period) ?? 0), 0);

  const active = items.filter(({ item }) => item.latestValue > EPSILON);

  const stopped = priorPeriods.length === 0
    ? []
    : items
        .filter(({ aggregate, item }) => item.latestValue <= EPSILON && priorValueOf(aggregate) > EPSILON)
        .map(({ item }) => item)
        .sort((left, right) => right.priorAverage - left.priorAverage);

  const dropping = priorPeriods.length === 0
    ? []
    : active
        .filter(({ item }) => item.priorAverage > EPSILON && item.latestValue <= item.priorAverage * DROPPING_RATIO + EPSILON)
        .map(({ item }) => item)
        .sort((left, right) => (right.priorAverage - right.latestValue) - (left.priorAverage - left.latestValue));

  const newPharmacies = priorPeriods.length === 0
    ? []
    : active
        .filter(({ aggregate }) => priorValueOf(aggregate) <= EPSILON)
        .map(({ item }) => item)
        .sort((left, right) => right.latestValue - left.latestValue);

  const top = active
    .map(({ item }) => ({
      ...item,
      share: latestTotals.pharmacies > EPSILON ? item.latestValue / latestTotals.pharmacies : null,
    }))
    .sort((left, right) => right.latestValue - left.latestValue)
    .slice(0, TOP_PHARMACY_LIMIT);

  // ── Cross-sell: the products most of the book buys, and who among the buyers is missing them ──
  const buyerCount = new Map<string, number>();
  if (latestPeriod) {
    for (const { aggregate } of active) {
      for (const code of aggregate.productsByPeriod.get(latestPeriod) ?? []) {
        buyerCount.set(code, (buyerCount.get(code) ?? 0) + 1);
      }
    }
  }
  const coreProducts = active.length < CORE_PRODUCT_MIN_PHARMACIES
    ? []
    : [...buyerCount]
        .filter(([, buyers]) => buyers / active.length >= CORE_PRODUCT_BUYER_SHARE)
        .sort((left, right) => right[1] - left[1] || (productNames.get(left[0]) ?? "").localeCompare(productNames.get(right[0]) ?? ""))
        .slice(0, CORE_PRODUCT_MAX)
        .map(([code, buyers]) => ({ code, name: productNames.get(code) ?? code, buyers }));

  const crossSell: CrossSellItem[] = coreProducts.length === 0
    ? []
    : active
        .map(({ aggregate, item }) => {
          const everBought = new Set<string>();
          for (const period of windowPeriods) for (const code of aggregate.productsByPeriod.get(period) ?? []) everBought.add(code);
          const buysSomeCore = coreProducts.some((product) => everBought.has(product.code));
          const missingProducts = coreProducts
            .filter((product) => !everBought.has(product.code))
            .map((product) => ({ code: product.code, name: product.name }));
          return buysSomeCore && missingProducts.length > 0 ? { ...item, missingProducts } : null;
        })
        .filter((entry): entry is CrossSellItem => entry !== null)
        .sort((left, right) => right.latestValue - left.latestValue);

  // ── Untapped bricks: covered, and no pharmacy in them bought anything across the whole window ──
  const seenBricks = new Set<string>();
  const untappedBricks = (input.brickUniverse ?? [])
    .filter((brick) => {
      const id = upper(brick.brickId);
      if (!id || seenBricks.has(id)) return false;
      seenBricks.add(id);
      return !bricksWithSales.has(id);
    })
    .map((brick) => ({ ...brick, areaCode: upper(brick.areaCode), areaName: areaLabel(brick.areaCode, brick.areaName) }))
    .sort((left, right) => left.areaName.localeCompare(right.areaName) || left.brickName.localeCompare(right.brickName));

  const areas = new Map<string, string>();
  for (const item of [...stopped, ...dropping, ...newPharmacies, ...top, ...crossSell]) {
    if (item.areaCode) areas.set(item.areaCode, areaLabel(item.areaCode, item.areaName));
  }
  for (const brick of untappedBricks) if (brick.areaCode) areas.set(brick.areaCode, areaLabel(brick.areaCode, brick.areaName));

  const sum = (list: PharmacyActionItem[], pick: (item: PharmacyActionItem) => number) =>
    round2(list.reduce((total, item) => total + pick(item), 0));

  // ── Per area, from the UNCAPPED lists ──
  const areaCodes = new Set<string>(otherTotalsByArea.keys());
  for (const { item } of items) if (item.areaCode) areaCodes.add(item.areaCode);
  for (const brick of untappedBricks) if (brick.areaCode) areaCodes.add(brick.areaCode);
  const byArea: Record<string, PharmacyAreaSummary> = {};
  for (const code of areaCodes) {
    const mine = <T extends { areaCode: string }>(list: T[]): T[] => list.filter((entry) => entry.areaCode === code);
    const areaItems = items.filter(({ item }) => item.areaCode === code).map(({ item }) => item);
    const areaActive = areaItems.filter((item) => item.latestValue > EPSILON);
    const areaStopped = mine(stopped);
    const areaDropping = mine(dropping);
    const areaNew = mine(newPharmacies);
    const areaCrossSell = mine(crossSell);
    const areaUntappedBricks = mine(untappedBricks);
    const other = otherTotalsByArea.get(code);
    const pharmacyValue = areaItems.reduce((total, item) => total + item.latestValue, 0);
    byArea[code] = {
      counts: {
        activePharmacies: areaActive.length,
        stopped: areaStopped.length,
        dropping: areaDropping.length,
        newPharmacies: areaNew.length,
        crossSell: mine(crossSell).length,
        untappedBricks: mine(untappedBricks).length,
      },
      valueAtStake: {
        stopped: sum(areaStopped, (item) => item.priorAverage),
        dropping: sum(areaDropping, (item) => item.priorAverage - item.latestValue),
        newPharmacies: sum(areaNew, (item) => item.latestValue),
      },
      latestTotals: {
        total: round2(pharmacyValue + (other?.total ?? 0)),
        pharmacies: round2(pharmacyValue),
        mainStores: round2(other?.mainStores ?? 0),
        wholesalerShares: round2(other?.wholesalerShares ?? 0),
        noCustomerCode: round2(other?.noCustomerCode ?? 0),
      },
      stopped: areaStopped.slice(0, ACTION_LIST_LIMIT),
      dropping: areaDropping.slice(0, ACTION_LIST_LIMIT),
      newPharmacies: areaNew.slice(0, ACTION_LIST_LIMIT),
      top: areaActive
        .map((item) => ({ ...item, share: pharmacyValue > EPSILON ? item.latestValue / pharmacyValue : null }))
        .sort((left, right) => right.latestValue - left.latestValue)
        .slice(0, TOP_PHARMACY_LIMIT),
      crossSell: areaCrossSell.slice(0, ACTION_LIST_LIMIT),
      untappedBricks: areaUntappedBricks.slice(0, ACTION_LIST_LIMIT),
    };
  }

  return {
    latestPeriod,
    priorPeriods,
    historyComplete: priorPeriods.length >= LOOKBACK_CLOSINGS,
    counts: {
      activePharmacies: active.length,
      stopped: stopped.length,
      dropping: dropping.length,
      newPharmacies: newPharmacies.length,
      crossSell: crossSell.length,
      untappedBricks: untappedBricks.length,
    },
    valueAtStake: {
      stopped: sum(stopped, (item) => item.priorAverage),
      dropping: sum(dropping, (item) => item.priorAverage - item.latestValue),
      newPharmacies: sum(newPharmacies, (item) => item.latestValue),
    },
    latestTotals: {
      total: round2(latestTotals.total),
      pharmacies: round2(latestTotals.pharmacies),
      mainStores: round2(latestTotals.mainStores),
      wholesalerShares: round2(latestTotals.wholesalerShares),
      noCustomerCode: round2(latestTotals.noCustomerCode),
    },
    coreProducts,
    stopped: stopped.slice(0, ACTION_LIST_LIMIT),
    dropping: dropping.slice(0, ACTION_LIST_LIMIT),
    newPharmacies: newPharmacies.slice(0, ACTION_LIST_LIMIT),
    top,
    crossSell: crossSell.slice(0, ACTION_LIST_LIMIT),
    untappedBricks: untappedBricks.slice(0, ACTION_LIST_LIMIT),
    areas: [...areas].map(([code, name]) => ({ code, name })).sort((left, right) => left.name.localeCompare(right.name)),
    byArea,
  };
}
