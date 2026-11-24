// HOW MANY PHARMACIES BOUGHT — counted from the Monthly Closing's own invoice rows.
//
// Owner, 24 Nov 2026: "in the monthly closing in the sales sheet every month, each area and each
// brick, how many pharmacy … the same what we did for Ibtisam". So the rule is the one his
// Ebtissam Alaa sheet used, which he read and accepted:
//
//   • ONE PHARMACY = one distributor customer — the distributor and its customer code together.
//     One distributor uses the same code for different pharmacies, so the code alone is not one.
//   • IT BOUGHT when its NET units in that area, product and month are above zero. Invoice lines are
//     not pharmacies: a +2 then -2 return is two lines and no purchase, and nine lines from one
//     pharmacy are one pharmacy. (His own pivot counted lines, which is why it read higher.)
//   • ONLY REAL PHARMACIES. Direct orders, Office, Main Stores and a wholesaler's city share are not
//     pharmacies that bought, so they are left out — the same classification the Pharmacy Actions
//     lists use (`classifyRowKind`), so the two pages can never disagree about who is a pharmacy.
//   • ONLY THE CLOSING'S OWN ROWS: `includedInClosing`, booked to the area the closing books them in
//     (`closingAreaOf`). Confidential products never reach these rows for anyone who may not see them.
//
// Several months at once (the admin "Several months" picker) count a pharmacy once if it bought in
// ANY of them — each month is judged on its own net first, then the months are joined.
//
// The result carries pharmacy IDS, not counts, per area and product. A region, the nation and a
// row's all-products total are then the number of DISTINCT ids across the areas actually on the
// grid — which is what keeps a filtered screen and a filtered workbook right without a second read.
// The ids are small integers that mean nothing outside one payload: no code or name leaves here.

import { closingAreaOf } from "@/lib/sales/closing-row-area";
import {
  classifyRowKind,
  findSharedCustomerKeys,
  type PeriodRows,
  type PharmacyActionRow,
} from "@/lib/sales/sos-pharmacy-actions";

/** The fields a row needs beyond what the Pharmacy Actions rules read. ClosingDetailRow has them. */
export type PharmacyCountRow = PharmacyActionRow & {
  qty: number;
  includedInClosing: boolean;
};

export type PharmacyCountPeriod = { period: string; rows: readonly PharmacyCountRow[] };

export type ClosingPharmacyBrick = {
  areaCode: string;
  brickId: string;
  brickName: string;
  /** productCode → the ids of the pharmacies in this brick that bought it. */
  products: Record<string, number[]>;
};

export type ClosingPharmacyCounts = {
  line: string;
  /** The months counted, oldest first. */
  periods: string[];
  /** areaCode → productCode → the ids of the pharmacies that bought it there. */
  areas: Record<string, Record<string, number[]>>;
  /** The same, one level down. Read by the workbook's brick sheet; the screen route leaves it out. */
  bricks: ClosingPharmacyBrick[];
};

const EPSILON = 1e-9;

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function keyOf(row: Pick<PharmacyCountRow, "distributorCode" | "clientCode">): string {
  return `${upper(row.distributorCode)}|${upper(row.clientCode)}`;
}

/** One pharmacy that BOUGHT one product in one area and brick, in one month (net units above zero). */
export type BuyingEntry = {
  /** distributor|client — the pharmacy's identity. Server-side only; never sent to a screen. */
  key: string;
  area: string;
  brickId: string;
  brickName: string;
  product: string;
  qty: number;
};

/**
 * THE RULE, once: one month's rows → the pharmacies that bought, per area, brick and product.
 * Every reader of the count (the Closing Matrix column, the Customer Count dashboard) goes through
 * here, so the two can never disagree about who bought.
 */
export function netBuyingEntries(rows: readonly PharmacyCountRow[], shared: ReadonlySet<string>): BuyingEntry[] {
  const net = new Map<string, BuyingEntry>();
  for (const row of rows) {
    if (row.includedInClosing !== true || row.isDirect) continue;
    if (classifyRowKind(row, shared) !== "pharmacy") continue;
    const area = closingAreaOf(row);
    const product = upper(row.productCode);
    if (!area || !product) continue;
    const key = keyOf(row);
    const brickId = String(row.brickId ?? "").trim();
    const cell = `${key}§${area}§${brickId}§${product}`;
    const entry = net.get(cell) ?? { key, area, brickId, brickName: String(row.brickName ?? "").trim(), product, qty: 0 };
    entry.qty += Number(row.qty) || 0;
    if (!entry.brickName && row.brickName) entry.brickName = String(row.brickName).trim();
    net.set(cell, entry);
  }
  return [...net.values()].filter((entry) => entry.qty > EPSILON);
}

/** One month judged ON ITS OWN — its shared (wholesaler) customers read from that month alone, which
 *  is exactly what that month's Closing Matrix column does. */
export function monthBuyingEntries(rows: readonly PharmacyCountRow[]): BuyingEntry[] {
  return netBuyingEntries(rows, findSharedCustomerKeys([{ period: "", rows }]));
}

/**
 * Count every area's and brick's buying pharmacies, per product, from the closing's invoice rows.
 * `periods` may come in any order; each month's rows are judged on their own.
 */
export function buildClosingPharmacyCounts(input: {
  line: string;
  periods: readonly PharmacyCountPeriod[];
}): ClosingPharmacyCounts {
  // A customer the closing shares across areas in ANY loaded month is a wholesaler in all of them —
  // the same reading the Pharmacy Actions lists make.
  const shared = findSharedCustomerKeys(input.periods as readonly PeriodRows[]);
  const ids = new Map<string, number>();
  const idOf = (key: string): number => {
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size + 1;
      ids.set(key, id);
    }
    return id;
  };

  const areas = new Map<string, Map<string, Set<number>>>();
  const bricks = new Map<string, { areaCode: string; brickId: string; brickName: string; products: Map<string, Set<number>> }>();
  const add = (bucket: Map<string, Set<number>>, product: string, id: number) => {
    const set = bucket.get(product) ?? new Set<number>();
    set.add(id);
    bucket.set(product, set);
  };

  for (const { rows } of input.periods) {
    const net = netBuyingEntries(rows, shared);
    for (const entry of net) {
      const id = idOf(entry.key);
      const areaBucket = areas.get(entry.area) ?? new Map<string, Set<number>>();
      add(areaBucket, entry.product, id);
      areas.set(entry.area, areaBucket);
      const brickKey = `${entry.area}§${entry.brickId}`;
      const brick = bricks.get(brickKey) ?? {
        areaCode: entry.area,
        brickId: entry.brickId,
        brickName: entry.brickName,
        products: new Map<string, Set<number>>(),
      };
      if (!brick.brickName && entry.brickName) brick.brickName = entry.brickName;
      add(brick.products, entry.product, id);
      bricks.set(brickKey, brick);
    }
  }

  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  const toRecord = (bucket: Map<string, Set<number>>) =>
    Object.fromEntries([...bucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([product, set]) => [product, sorted(set)]));

  return {
    line: input.line,
    periods: [...new Set(input.periods.map((entry) => entry.period))].sort(),
    areas: Object.fromEntries([...areas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, bucket]) => [area, toRecord(bucket)])),
    bricks: [...bricks.values()]
      .sort((a, b) => a.areaCode.localeCompare(b.areaCode) || (a.brickName || a.brickId).localeCompare(b.brickName || b.brickId))
      .map((brick) => ({ areaCode: brick.areaCode, brickId: brick.brickId, brickName: brick.brickName, products: toRecord(brick.products) })),
  };
}
