import { isStoreCustomerForPeriod } from "@/lib/sales/customer-channel";
import {
  isSplitEligible,
  isSplitEligibleLine,
  isStoreCitySplitActive,
  isUnlistedArea,
  splitTargetsFor,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHERE WILL THIS FILE'S SALES ACTUALLY LAND? — the split plan, shown at validation.
//
// Owner, 2026-09-07: "you only consider the qty and the city, then must in validation show the city
// and show how it will be distributed."
//
// The import preview already answered "how much of this file resolves". It never answered the
// question the owner actually asks of a wholesaler file, which is WHERE THE MONEY GOES — and for a
// distributor like El Qema that is the whole story: one customer in Qalubeya reaches seven areas,
// another in Sohag reaches two, and a third reaches only itself. Until this existed, the only way to
// find out was to import the file and read the closing afterwards.
//
// IT IS A PLAN, NOT A RESULT. It is computed from the rows the importer WOULD write, before anything
// is persisted, using the SAME functions the closing itself uses — isSplitEligible, splitTargetsFor
// and isStoreCustomerForPeriod. Nothing is duplicated here: if the plan and the closing ever
// disagree, that is a bug in this file, because the rule has exactly one implementation and this
// module calls it.
//
// WHY EVERY "NO" CARRIES A REASON. A customer that does not split is not necessarily a mistake — a
// one-area governorate has nothing to divide across, a pharmacy is not meant to split, and a month
// before the start period does not split at all. The reason is what tells the reader which of those
// they are looking at, so a legitimate "stays whole" is never chased as a fault and a genuine
// misclassification is never waved through.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The minimum a parsed row needs. Structural, so ParsedDistributorRow satisfies it with no adapter. */
export type SplitPlanSourceRow = {
  areaCode: string | null;
  clientCode: string | null;
  clientName: string | null;
  distributorCode: string | null;
  isDirect?: boolean;
  officialLine: string | null;
  /** Required by the 200-pack warehouse rule, which is judged per product and not per basket. */
  productCode?: string | null;
  qty: number;
};

export type SplitPlanCustomer = {
  clientCode: string;
  clientName: string;
  /** The area the file books this customer in. */
  originArea: string;
  /** The governorate, or the label of a national split such as "Qalubeya + nationwide". */
  group: string | null;
  /** Every area the units will reach, origin included. Empty when nothing moves. */
  targetAreas: string[];
  units: number;
  /**
   * Units each area of the ORIGIN GOVERNORATE receives.
   *
   * It used to be every target area, equal by construction. The El Qema 200-pack rule ended that:
   * above the threshold half the sale stays in the governorate and half crosses the country, so
   * one number can no longer describe both sides. `unitsPerAwayArea` carries the other one.
   */
  unitsPerArea: number;
  /** Units each area OUTSIDE the governorate receives. 0 unless the national half applied. */
  unitsPerAwayArea: number;
  /** True when at least one product crossed 200 packs and took the national half. */
  nationalSplit: boolean;
  willSplit: boolean;
  /** Present only when `willSplit` is false: why this customer's sales stay where they are. */
  reason: string | null;
};

export type ImportSplitPlan = {
  /** False when the period predates the split entirely — then nothing in the file splits. */
  splitActive: boolean;
  period: string;
  splittingCustomers: number;
  splittingUnits: number;
  wholeCustomers: number;
  wholeUnits: number;
  /** Widest fan-out in the file, for the headline ("one customer reaches 7 areas"). */
  widestFanOut: number;
  /**
   * Areas in this file that the city list has never heard of — neither grouped into a city nor
   * deliberately excluded. Normally empty. Non-empty means an area was created and the city list has
   * not caught up, so nothing in that area will ever split until someone adds it.
   */
  unlistedAreas: string[];
  customers: SplitPlanCustomer[];
};

const CUSTOMER_CAP = 200;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Why this customer's units are not moving. Ordered the same way `isSplitEligible` decides, so the
 * reason names the FIRST gate that stopped it rather than a later one that also would have.
 */
function reasonNotSplit(row: StoreSplitRow, period: string, thresholdQty?: number): string {
  if (row.isDirect) return "direct order — placed by its own area, never split";
  if (!row.includedInClosing) return "not included in the closing";
  if (!isSplitEligibleLine(row.officialLine)) {
    return `${text(row.officialLine) || "this line"} is not a split line (Head Office never splits)`;
  }
  if (
    !isStoreCustomerForPeriod(row.clientName, row.clientCode, row.distributorCode, period, row.officialLine)
  ) {
    // The cutover is per line, so the honest reason names the line as well as the month.
    return `classified as a pharmacy, not a wholesaler (on ${text(row.officialLine) || "this line"} for ${period})`;
  }
  const targets = splitTargetsFor(row, thresholdQty);
  if (!targets) return `area ${text(row.areaCode) || "(blank)"} is not on the city list — sales stay where they are`;
  if (targets.areas.length <= 1) {
    return `${targets.group} holds one area only — nothing to divide across`;
  }
  return "does not split";
}

/**
 * What the city split WILL do to this file, computed before a single row is written.
 *
 * `period` decides two separate things and both matter: whether the split runs at all
 * (STORE_CITY_SPLIT_FROM_PERIOD, August 2026) and which warehouse rule says who is a wholesaler
 * (warehouseRuleFromPeriod — PER LINE: August for Pedia, September for everything else). A file for
 * a month before either gate is not broken — it simply does not split, and `splitActive` says so
 * rather than leaving the reader to infer it from an empty list.
 *
 * Because the second gate is per line, one imported file can legitimately show a customer splitting
 * on Pedia and not on Anti Infective in the same month. Each row's `reason` names the line for
 * exactly that case, so it reads as a rule rather than as an inconsistency.
 */
export function buildImportSplitPlan(input: {
  period: string | null | undefined;
  rows: readonly SplitPlanSourceRow[];
}): ImportSplitPlan {
  const period = text(input.period);
  const splitActive = isStoreCitySplitActive(period);

  // Grouped by customer AND origin area: one chain trading in two areas is two placements, and
  // folding them together would report a fan-out that never happens.
  // Displayed per customer x area, but summed per PRODUCT underneath: the 200-pack rule is judged
  // per product, so a customer whose basket totals 300 across three products has crossed nothing.
  // Reading the basket total would report a national fan-out that the closing will not perform.
  const byKey = new Map<
    string,
    { row: StoreSplitRow; units: number; byProduct: Map<string, number> }
  >();
  for (const raw of input.rows) {
    const clientCode = text(raw.clientCode);
    if (!clientCode) continue;
    const areaCode = text(raw.areaCode).toUpperCase();
    const key = `${clientCode}|${areaCode}`;
    const productCode = text(raw.productCode).toUpperCase();
    const qty = Number(raw.qty) || 0;
    const found = byKey.get(key);
    if (found) {
      found.units += qty;
      found.byProduct.set(productCode, (found.byProduct.get(productCode) ?? 0) + qty);
      continue;
    }
    byKey.set(key, {
      byProduct: new Map([[productCode, qty]]),
      units: qty,
      row: {
        areaCode,
        clientCode,
        clientName: text(raw.clientName),
        distributorCode: text(raw.distributorCode),
        includedInClosing: true,
        isDirect: Boolean(raw.isDirect),
        officialLine: text(raw.officialLine),
        productCode,
        qty,
        salesValue: 0,
      },
    });
  }

  const customers: SplitPlanCustomer[] = [];
  let splittingCustomers = 0;
  let splittingUnits = 0;
  let wholeCustomers = 0;
  let wholeUnits = 0;
  let widestFanOut = 0;
  const unlisted = new Set<string>();

  for (const { row, units, byProduct } of byKey.values()) {
    if (isUnlistedArea(row.areaCode)) unlisted.add(row.areaCode);

    // One plan per product, because only the product decides which side of 200 it falls on. The
    // customer line then reports the union of what its products reach.
    const reached = new Set<string>();
    let unitsPerHomeArea = 0;
    let unitsPerAwayArea = 0;
    let nationalSplit = false;
    let group: string | null = null;
    let widestProduct = 0;
    let biggestProductUnits = 0;

    for (const [productCode, productUnits] of byProduct) {
      const productRow: StoreSplitRow = { ...row, productCode, qty: productUnits };
      if (productUnits > biggestProductUnits) biggestProductUnits = productUnits;
      const plan = splitActive && isSplitEligible(productRow, period, productUnits)
        ? splitTargetsFor(productRow, productUnits)
        : null;
      if (!plan || plan.areas.length <= 1) continue;
      for (const area of plan.areas) reached.add(area);
      if (plan.areas.length > widestProduct) {
        widestProduct = plan.areas.length;
        group = plan.group;
      }
      const home = productUnits * plan.homeFraction;
      unitsPerHomeArea += home / plan.homeAreas.length;
      if (plan.awayAreas.length > 0) {
        nationalSplit = true;
        unitsPerAwayArea += (productUnits - home) / plan.awayAreas.length;
      }
    }

    const areas = [...reached].sort();
    const willSplit = areas.length > 1;

    if (willSplit) {
      splittingCustomers += 1;
      splittingUnits += units;
      widestFanOut = Math.max(widestFanOut, areas.length);
    } else {
      wholeCustomers += 1;
      wholeUnits += units;
    }

    customers.push({
      clientCode: row.clientCode,
      clientName: row.clientName,
      group: group ?? splitTargetsFor(row, biggestProductUnits)?.group ?? null,
      nationalSplit,
      originArea: row.areaCode,
      reason: willSplit
        ? null
        : splitActive
          ? reasonNotSplit(row, period, biggestProductUnits)
          : `the city split does not apply to ${period || "this period"}`,
      targetAreas: areas,
      units,
      unitsPerArea: willSplit ? unitsPerHomeArea : units,
      unitsPerAwayArea: willSplit ? unitsPerAwayArea : 0,
      willSplit,
    });
  }

  // Biggest first: the reader wants the customers that move the most money, and a file with hundreds
  // of small pharmacies must not bury the one wholesaler that reaches seven areas.
  customers.sort((a, b) => b.units - a.units || a.clientCode.localeCompare(b.clientCode));

  return {
    customers: customers.slice(0, CUSTOMER_CAP),
    period,
    splitActive,
    splittingCustomers,
    splittingUnits,
    unlistedAreas: [...unlisted].sort(),
    wholeCustomers,
    wholeUnits,
    widestFanOut,
  };
}
