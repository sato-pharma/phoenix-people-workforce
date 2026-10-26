import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { rankingHrKey } from "@/lib/sales/rankings";
import {
  type AchievementCell,
  type PeriodColumn,
  type RepAchievementProduct,
  type RepAchievementRecord,
} from "@/lib/sales/rep-product-achievement";
import { isRowPublished } from "@/lib/sales/vs-target";

// ─────────────────────────────────────────────────────────────────────────────
// THE ARITHMETIC behind every cell of Rep Achievement by Product. Pure: the rows, the published
// (line, month) keys and the names come in, and nothing here reads a table.
//
// 🔴 ONE RULE, THE CLOSING'S. A cell is the rep's ALL sales over the column's published months ÷ the
// target over those months, divided ONCE — the Rankings board's `addTo` (rankings.ts, "every pound
// counts, targeted product or not"). Never a mean of monthly percentages: a quarter of 50% on a
// 10,000 target and 150% on a 1,000 target is 59%, not 100%.
//
// 🔴 PRODUCTS ARE ADDED BY VALUE ONLY. The "all products" cell sums sales VALUE and target VALUE;
// units of different products are never added (owner rule).
//
// 🔴 A MONTH NOBODY PUBLISHED IS NOT A NUMBER. Months are kept only where the row's own line has a
// published closing (`isRowPublished`); a column whose started months are all unpublished reads
// "unpublished", never 0%.
//
// The caller hands rows already merged (`applyAchievementAreaMerges`) and credited to the person who
// held each seat that month (`creditRepRowsByTenure`), restricted products already out. A row with
// no rep is the area's, never a rep's, and is skipped here.
// ─────────────────────────────────────────────────────────────────────────────

export type RepAchievementPerson = {
  name: string;
  jobTitle: string;
  areaName: string;
  regionName: string;
  managerName: string;
  left: boolean;
};

export type BuildRepAchievementInput = {
  rows: readonly AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  columns: readonly PeriodColumn[];
  /** The current Cairo month — any month after it has not started. */
  currentPeriod: string;
  /** rankingHrKey(hrId) → the person. */
  people: ReadonlyMap<string, RepAchievementPerson>;
  /** product code (upper) → name. */
  productNames: ReadonlyMap<string, string>;
  lineNames: ReadonlyMap<string, string>;
};

type Sums = { sales: number; target: number; rows: number };

/** month → sums, for one (rep, line) and either one product or all of them. */
type MonthSums = Map<string, Sums>;

function addToMonth(months: MonthSums, row: AchievementRow): void {
  let sums = months.get(row.period);
  if (!sums) months.set(row.period, (sums = { rows: 0, sales: 0, target: 0 }));
  sums.sales += row.actualValue;
  sums.target += row.targetValue ?? 0;
  sums.rows += 1;
}

/** One cell — the column's started, published months summed once. */
export function cellFor(
  months: MonthSums,
  column: PeriodColumn,
  lineCode: string,
  publishedKeys: ReadonlySet<string>,
  currentPeriod: string,
): AchievementCell {
  const started = column.months.filter((month) => month <= currentPeriod);
  if (started.length === 0) return { partial: false, state: "upcoming", value: null };
  const published = started.filter((month) => isRowPublished({ lineCode, period: month }, publishedKeys));
  if (published.length === 0) return { partial: false, state: "unpublished", value: null };

  let sales = 0;
  let target = 0;
  let rows = 0;
  for (const month of published) {
    const sums = months.get(month);
    if (!sums) continue;
    sales += sums.sales;
    target += sums.target;
    rows += sums.rows;
  }
  const partial = published.length < column.months.length;
  if (target > 0) return { partial, state: "graded", value: sales / target };
  return { partial, state: rows > 0 ? "no-target" : "none", value: null };
}

/** Every rep × line × product, with his overall row, as the page and the export read them. */
export function buildRepAchievementRecords(input: BuildRepAchievementInput): RepAchievementRecord[] {
  const { columns, currentPeriod, lineNames, people, productNames, publishedKeys } = input;
  const window = new Set(columns.flatMap((column) => column.months));

  type Group = { lineCode: string; hrKey: string; overall: MonthSums; products: Map<string, MonthSums> };
  const groups = new Map<string, Group>();

  for (const row of input.rows) {
    if (!window.has(row.period)) continue;
    if (!row.lineCode) continue;
    const hrKey = rankingHrKey(row.repHrId);
    if (!hrKey) continue;
    const key = `${row.lineCode}|${hrKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { hrKey, lineCode: row.lineCode, overall: new Map(), products: new Map() };
      groups.set(key, group);
    }
    addToMonth(group.overall, row);
    const productCode = String(row.productCode ?? "").trim().toUpperCase();
    if (!productCode) continue;
    let productMonths = group.products.get(productCode);
    if (!productMonths) group.products.set(productCode, (productMonths = new Map()));
    addToMonth(productMonths, row);
  }

  const records: RepAchievementRecord[] = [];
  for (const [key, group] of groups) {
    const person = people.get(group.hrKey);
    const cells = (months: MonthSums) =>
      columns.map((column) => cellFor(months, column, group.lineCode, publishedKeys, currentPeriod));
    const products: RepAchievementProduct[] = [...group.products.entries()]
      .map(([productCode, months]) => ({
        cells: cells(months),
        productCode,
        productName: productNames.get(productCode) ?? "Product not on the master list",
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
    records.push({
      areaName: person?.areaName ?? "",
      jobTitle: person?.jobTitle ?? "",
      key,
      left: person?.left ?? false,
      lineCode: group.lineCode,
      lineName: lineNames.get(group.lineCode) ?? group.lineCode,
      managerName: person?.managerName ?? "",
      name: person?.name ?? "Name not on the employee list",
      overall: cells(group.overall),
      products,
      regionName: person?.regionName ?? "",
    });
  }
  return records.sort((a, b) => a.name.localeCompare(b.name) || a.lineName.localeCompare(b.lineName));
}
