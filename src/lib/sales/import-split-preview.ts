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
  qty: number;
};

export type SplitPlanCustomer = {
  clientCode: string;
  clientName: string;
  /** The area the file books this customer in. */
  originArea: string;
  /** The city, or the label of a distributor override such as "Qalubeya + Cairo (El Qema)". */
  group: string | null;
  /** Every area the units will reach, origin included. Empty when nothing moves. */
  targetAreas: string[];
  units: number;
  /** Units each target area receives. Equal by construction — the split is always even. */
  unitsPerArea: number;
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
function reasonNotSplit(row: StoreSplitRow, period: string): string {
  if (row.isDirect) return "direct order — placed by its own area, never split";
  if (!row.includedInClosing) return "not included in the closing";
  if (!isSplitEligibleLine(row.officialLine)) {
    return `${text(row.officialLine) || "this line"} is not a split line (Head Office never splits)`;
  }
  if (!isStoreCustomerForPeriod(row.clientName, row.clientCode, row.distributorCode, period)) {
    return "classified as a pharmacy, not a wholesaler";
  }
  const targets = splitTargetsFor(row);
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
 * (WAREHOUSE_RULE_FROM_PERIOD, September 2026). A file for a month before either gate is not
 * broken — it simply does not split, and `splitActive` says so rather than leaving the reader to
 * infer it from an empty list.
 */
export function buildImportSplitPlan(input: {
  period: string | null | undefined;
  rows: readonly SplitPlanSourceRow[];
}): ImportSplitPlan {
  const period = text(input.period);
  const splitActive = isStoreCitySplitActive(period);

  // Grouped by customer AND origin area: one chain trading in two areas is two placements, and
  // folding them together would report a fan-out that never happens.
  const byKey = new Map<string, { row: StoreSplitRow; units: number }>();
  for (const raw of input.rows) {
    const clientCode = text(raw.clientCode);
    if (!clientCode) continue;
    const areaCode = text(raw.areaCode).toUpperCase();
    const key = `${clientCode}|${areaCode}`;
    const qty = Number(raw.qty) || 0;
    const found = byKey.get(key);
    if (found) {
      found.units += qty;
      continue;
    }
    byKey.set(key, {
      units: qty,
      row: {
        areaCode,
        clientCode,
        clientName: text(raw.clientName),
        distributorCode: text(raw.distributorCode),
        includedInClosing: true,
        isDirect: Boolean(raw.isDirect),
        officialLine: text(raw.officialLine),
        productCode: "",
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

  for (const { row, units } of byKey.values()) {
    if (isUnlistedArea(row.areaCode)) unlisted.add(row.areaCode);
    const eligible = splitActive && isSplitEligible(row, period);
    const targets = eligible ? splitTargetsFor(row) : null;
    const areas = targets ? [...targets.areas] : [];
    const willSplit = eligible && areas.length > 1;

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
      group: targets?.group ?? splitTargetsFor(row)?.group ?? null,
      originArea: row.areaCode,
      reason: willSplit
        ? null
        : splitActive
          ? reasonNotSplit(row, period)
          : `the city split does not apply to ${period || "this period"}`,
      targetAreas: willSplit ? areas.slice().sort() : [],
      units,
      unitsPerArea: willSplit ? units / areas.length : units,
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
