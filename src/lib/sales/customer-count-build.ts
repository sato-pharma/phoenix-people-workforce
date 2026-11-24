// Builds the Customer Count dashboard's payload from the closing's own invoice rows. Pure — the
// loader (customer-count-loader.ts) decides which rows reach it; this decides nothing about access.
//
// WHO BOUGHT comes from `monthBuyingEntries`, the one rule the Closing Matrix's Pharmacies column
// also reads, each month judged on its own. A pharmacy keeps ONE id across every line and month of
// the payload (distributor + customer code), so "all lines" counts a pharmacy that buys Pedia and
// CNS once.

import { closingAreaOf } from "@/lib/sales/closing-row-area";
import { monthBuyingEntries, type PharmacyCountRow } from "@/lib/sales/closing-pharmacy-counts";
import type { CustomerCountFact, CustomerCountPayload } from "@/lib/sales/customer-count-dashboard";

/** The row fields beyond the counting rule that the dashboard names things from. */
export type CustomerCountRow = PharmacyCountRow & {
  regionName?: string | null;
  operationalRegionName?: string | null;
};

export type CustomerCountInput = {
  /** The months on show, any order — the screen's axis. A month no line had rows in still shows. */
  months: readonly string[];
  lines: { line: string; months: { month: string; rows: readonly CustomerCountRow[] }[] }[];
  /** The rep on (line, area)'s seat at the end of the month; null when nobody is named. */
  repFor: (line: string, area: string, month: string) => string | null;
  availableMonths: string[];
  availableLines: string[];
  unpublished: { line: string; month: string }[];
};

const upper = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();
const text = (value: string | null | undefined) => String(value ?? "").trim();

export const NO_REP_LABEL = "No rep on the seat";

class Dictionary {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();
  of(value: string): number {
    let id = this.index.get(value);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(value);
      this.index.set(value, id);
    }
    return id;
  }
}

export function buildCustomerCountPayload(input: CustomerCountInput): CustomerCountPayload {
  const months = [...new Set(input.months)].sort();
  const monthIndex = new Map(months.map((month, index) => [month, index]));

  const lines = new Dictionary();
  const regions = new Dictionary();
  const reps = new Dictionary();
  const pharmacies = new Map<string, number>();

  const areas: CustomerCountPayload["areas"] = [];
  const areaIndex = new Map<string, number>();
  const products: CustomerCountPayload["products"] = [];
  const productIndex = new Map<string, number>();
  const bricks: CustomerCountPayload["bricks"] = [];
  const brickIndex = new Map<string, number>();
  const facts: CustomerCountFact[] = [];
  const seen = new Set<string>();

  for (const { line, months: lineMonths } of input.lines) {
    const lineId = lines.of(line);
    for (const { month, rows } of lineMonths) {
      const monthId = monthIndex.get(month);
      if (monthId === undefined) continue;

      // Names, read off the rows the closing books in each area — the area's sheet name and its
      // organogram region, which is how the Closing Matrix groups it.
      const areaNames = new Map<string, { name: string; region: string }>();
      const productNames = new Map<string, string>();
      for (const row of rows) {
        const area = closingAreaOf(row);
        if (area && !areaNames.has(area)) {
          const ownName = upper(row.sheetAreaCode) === area ? text(row.sheetAreaName) : upper(row.areaCode) === area ? text(row.areaName) : "";
          const region = text(row.operationalRegionName) || text(row.regionName);
          if (ownName || region) areaNames.set(area, { name: ownName, region });
        }
        const product = upper(row.productCode);
        if (product && !productNames.has(product) && text(row.productName)) productNames.set(product, text(row.productName));
      }

      for (const entry of monthBuyingEntries(rows)) {
        let pharmacy = pharmacies.get(entry.key);
        if (pharmacy === undefined) {
          pharmacy = pharmacies.size + 1;
          pharmacies.set(entry.key, pharmacy);
        }

        let area = areaIndex.get(entry.area);
        if (area === undefined) {
          const named = areaNames.get(entry.area);
          area = areas.length;
          areas.push({ code: entry.area, name: named?.name || entry.area, region: regions.of(named?.region || "Region not mapped") });
          areaIndex.set(entry.area, area);
        } else if (areas[area].name === entry.area && areaNames.get(entry.area)?.name) {
          areas[area].name = areaNames.get(entry.area)!.name;
        }

        const productKey = `${lineId}|${entry.product}`;
        let product = productIndex.get(productKey);
        if (product === undefined) {
          product = products.length;
          products.push({ code: entry.product, name: productNames.get(entry.product) || entry.product, line: lineId });
          productIndex.set(productKey, product);
        }

        const brickKey = `${entry.area}|${entry.brickId || entry.brickName}`;
        let brick = brickIndex.get(brickKey);
        if (brick === undefined) {
          brick = bricks.length;
          bricks.push({ name: entry.brickName, area });
          brickIndex.set(brickKey, brick);
        } else if (!bricks[brick].name && entry.brickName) {
          bricks[brick].name = entry.brickName;
        }

        const rep = reps.of(input.repFor(line, entry.area, month) || NO_REP_LABEL);
        const dedupe = `${monthId}|${lineId}|${pharmacy}|${area}|${brick}|${product}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        facts.push([monthId, lineId, pharmacy, area, brick, product, rep]);
      }
    }
  }

  return {
    months,
    lines: lines.list,
    products,
    regions: regions.list,
    areas,
    bricks,
    reps: reps.list,
    facts,
    availableMonths: input.availableMonths,
    availableLines: input.availableLines,
    unpublished: input.unpublished,
  };
}
