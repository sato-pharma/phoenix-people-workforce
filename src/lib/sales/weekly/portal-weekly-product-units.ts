// Weekly Sales — PER-PRODUCT UNITS BY MONTH, per rep.
//
// WHAT THE OWNER ASKED FOR, IN HIS WORDS: the Performance Review's per-product units tab, "the same
// per-product units tab", on the Weekly Sales review. Its shape is his: one block per product,
// merged, with that product's months under it and its growth beside them, reps down the side.
//
// WHY THIS IS NOT THE FIELD FORCE TAB. The Field Force tab is rep-major — a person's row, his weeks
// across the top, his products inside him — and it answers "how is Sally doing". This one is
// PRODUCT-major and MONTH-wide: it answers "how did Royanoxicam move, person by person, July to
// September", which is a different question and the one a product manager opens a review for.
//
// FOUR RULES THIS FILE IS BUILT AROUND
//
//  1. UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule). A block is ONE product code, so a
//     figure may be read across its own months and summed down its own column — and there is
//     deliberately NO row total, because a row spans products. `unitsAreAddable` carries that
//     decision on the data rather than leaving a renderer to assume it.
//
//  2. EVERY WEEKLY REPORT SETS `excludeUnmapped` (owner rule, module memory). It matters more here
//     than anywhere: an unmapped SKU double-counts against the real product it belongs to, and this
//     grid is nothing but per-product unit counts. Unlike the Field Force tab — which deliberately
//     keeps unmapped rows so its reps add to the KPI strip beside them — this tab loads on its own
//     and totals nothing but itself, so the strictness costs nothing and the screen says so.
//
//  3. AN ALLOCATED NUMBER IS NEVER SHOWN AS AN OBSERVED ONE. A weekly row is a depot shipment. Where
//     the owner mapped the branch by hand the credit is exact; everywhere else it is spread by the
//     branch name, which is why most of these unit cells are fractions of a unit. The matrix carries
//     the exact/allocated mix of the whole window so the screen can say it out loud.
//
//  4. MONEY THAT REACHED NO REP IS REPORTED, NEVER DROPPED. A depot whose name states no place
//     reaches no area and so no rep; it rides the grid under its line's own named bucket, exactly as
//     the Field Force tab does. Dropping it would make the rows add to less than the line really sold.

import { type AccessContext } from "@/lib/auth/permissions";
import { regionOrder } from "@/lib/sales/closing-performance-review-regions";
import { isFuturePeriod } from "@/lib/sales/periods";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { resolveWeeklyOwnAreaKeys } from "@/lib/sales/weekly/own-area-scope";
import { mayLiftWeeklyGeography } from "@/lib/sales/weekly/own-area-share";
import {
  buildPortalWeeklyFieldForce,
  fieldForceLineKey,
  loadFieldForceSeatIndex,
  type FieldForceRep,
  type PortalWeeklyFieldForce,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import {
  WEEKLY_PRODUCT_UNITS_MAX_MONTHS,
  WEEKLY_PRODUCT_UNITS_MONTHS,
  type WeeklyProductUnitsColumn,
  type WeeklyProductUnitsMatrix,
  type WeeklyProductUnitsRow,
} from "@/lib/sales/weekly/product-units-shape";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyFactExportRow } from "@/lib/sales/weekly/types";

// The window constants and the row/column types live in `product-units-shape.ts` and are
// re-exported here, so every existing caller — the route, the tests — still reads one module. The
// split is NOT cosmetic: the `"use client"` grid needs the two constants, and importing them from
// here would drag the weekly service and `node:crypto` into the client bundle, which webpack
// refuses outright. Pinned by `tests/client-bundle-server-leak.test.ts`.
export {
  WEEKLY_PRODUCT_UNITS_MAX_MONTHS,
  WEEKLY_PRODUCT_UNITS_MONTHS,
};
export type { WeeklyProductUnitsColumn, WeeklyProductUnitsMatrix, WeeklyProductUnitsRow };

/** A first-of-month code, or null. Anything else is refused rather than silently read as a month. */
function normalizeMonth(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-01$/.test(text) ? text : null;
}

/** Newest over the one before it. null unless BOTH months are real and the earlier one is non-zero. */
function growthOf(series: Array<number | null>): number | null {
  for (let index = series.length - 1; index > 0; index -= 1) {
    const latest = series[index];
    const previous = series[index - 1];
    if (latest == null || previous == null || previous === 0) continue;
    return latest / previous - 1;
  }
  return null;
}

/**
 * Pick the window: the newest `count` uploaded cycle months, oldest first.
 *
 * Driven by what has actually been uploaded, so a month nobody has sent yet never becomes an empty
 * column, and a gap in the middle of the history keeps its own column (as a column of nulls) rather
 * than being skipped over.
 *
 * THE FUTURE-MONTH RULE: a month AFTER today (Cairo) is never a column. A Direct order collecting next
 * month legitimately uploads a thin cycle month ahead of time; as the window's last column it read
 * every other product at 0 and put −100% on all of them. `today` is a test seam.
 */
export function selectWeeklyProductUnitsMonths(available: string[], count: number, today?: string): string[] {
  const months = [
    ...new Set(
      available
        .map(normalizeMonth)
        .filter((m): m is string => m !== null && !isFuturePeriod(m, today)),
    ),
  ].sort();
  const window = Math.min(Math.max(1, count), WEEKLY_PRODUCT_UNITS_MAX_MONTHS);
  return months.slice(-window);
}

/**
 * Assemble the grid from one field-force build PER MONTH.
 *
 * Pure and synchronous: the caller does the reading, which is what lets a test drive the whole grid
 * from fixtures and keeps the loading order visible at the call site — the same split the
 * field-force builder itself uses.
 *
 * `perMonth` must be oldest first and must have been built with ONE shared product axis, so that
 * block N is the same product in every month.
 */
export function buildWeeklyProductUnitsMatrix(input: {
  perMonth: Array<{ cycleMonth: string; grid: PortalWeeklyFieldForce | null }>;
  /** The axis, already ordered. Each entry is one product code. */
  productAxis: Array<{ code: string; name: string; value: number }>;
  generatedAt?: string;
  seatIndexUnavailable?: boolean;
}): WeeklyProductUnitsMatrix {
  const months = input.perMonth.map((entry) => entry.cycleMonth);
  const columns: WeeklyProductUnitsColumn[] = input.productAxis.map((product) => ({
    key: product.code,
    label: product.name || product.code,
    subLabel: product.code,
    // A block is one product code by construction, so its units are a real quantity.
    unitsAreAddable: true,
    value: product.value,
  }));
  const columnIndex = new Map(columns.map((column, index) => [column.key, index]));

  const emptyBlocks = (): Array<Array<number | null>> =>
    columns.map(() => months.map(() => null as number | null));

  // A null stays null until something real lands on it: a subtotal over three unuploaded months is
  // "not uploaded", not zero — the same rule the monthly grid's addInto follows.
  const addInto = (target: Array<Array<number | null>>, source: Array<Array<number | null>>) => {
    source.forEach((series, productIndex) => {
      series.forEach((value, monthIndex) => {
        if (value == null) return;
        target[productIndex][monthIndex] = (target[productIndex][monthIndex] ?? 0) + value;
      });
    });
  };

  // Every row that appears in ANY month of the window, in one pass: a rep who sold in July and not
  // in September still gets his row, with September reading 0 rather than vanishing.
  type Collected = {
    blocks: Array<Array<number | null>>;
    rep: FieldForceRep;
    sawSales: boolean;
  };
  const collected = new Map<string, Collected>();
  const emptyMonths: string[] = [];
  /** Which months a sheet actually arrived for. The ONLY thing that decides null against 0. */
  const uploaded = input.perMonth.map(() => false);
  let value = 0;
  let exactValue = 0;
  let allocatedValue = 0;
  let unattributedValue = 0;
  let seatIndexUnavailable = input.seatIndexUnavailable === true;

  input.perMonth.forEach((entry, monthIndex) => {
    const grid = entry.grid;
    if (!grid || grid.reps.length === 0) {
      emptyMonths.push(entry.cycleMonth);
      return;
    }
    uploaded[monthIndex] = true;
    if (grid.seatIndexUnavailable) seatIndexUnavailable = true;
    value += grid.totals.value;
    exactValue += grid.totals.exactValue;
    allocatedValue += grid.totals.allocatedValue;
    unattributedValue += grid.totals.unattributedValue;

    for (const rep of grid.reps) {
      let row = collected.get(rep.key);
      if (!row) {
        row = { blocks: emptyBlocks(), rep, sawSales: false };
        collected.set(rep.key, row);
      }
      // The LATEST month's seat wins the name: a seat that changed hands inside the window shows the
      // person sitting in it now, which is who the reader is about to go and talk to.
      row.rep = rep;
      if (rep.value > 0) row.sawSales = true;
      for (const product of rep.products) {
        const index = columnIndex.get(product.productCode);
        if (index == null) continue;
        const units = Number(product.units) || 0;
        row.blocks[index][monthIndex] = (row.blocks[index][monthIndex] ?? 0) + units;
      }
    }
  });

  // NULL AND 0 ARE DIFFERENT FACTS, and only the MONTH decides which: a month no distributor sent a
  // sheet for is "not uploaded" and stays null for everybody, while a month that did arrive reads 0
  // wherever nothing moved — including for a person or a bucket that is absent from that month's grid
  // entirely, which is what "he sold none of it" looks like from here. Filling after the collection
  // rather than inside it is the whole difference: inside it, a row that first appears in August
  // would have kept a null for July, and a reader cannot tell that from a missing sheet.
  for (const row of collected.values()) {
    for (const series of row.blocks) {
      series.forEach((value, monthIndex) => {
        if (value == null && uploaded[monthIndex]) series[monthIndex] = 0;
      });
    }
  }

  // Line → region → area, which is how the Field Force tab already sections the same people, and the
  // only grouping that is honest here: a product belongs to ONE line, so a region subtotal that
  // spanned lines would stack a CNS region's reps on a Pedia product's empty column.
  type RegionGroup = { regionCode: string; regionName: string; rows: Collected[] };
  type LineGroup = {
    lineCode: string;
    lineName: string;
    regions: Map<string, RegionGroup>;
    residue: Collected[];
  };
  const lines = new Map<string, LineGroup>();
  for (const row of collected.values()) {
    // THE NORMALIZED LINE KEY, never `rep.lineCode` raw: a seated rep carries his seat's code ("cns")
    // and the residue bucket carries the line NAME ("CNS"), so grouping on the raw field splits one
    // line into two — the regions under one heading and the money that reached no area under another,
    // with neither total being the line's. `fieldForceLineKey` is the same collapse the seat index
    // itself is keyed by, so "Anti infective", "anti_infective" and "Anti-Infective" are one line here
    // exactly as they are there.
    const lineCode = fieldForceLineKey(row.rep.lineCode || row.rep.lineName);
    let line = lines.get(lineCode);
    if (!line) {
      line = { lineCode, lineName: row.rep.lineName, regions: new Map(), residue: [] };
      lines.set(lineCode, line);
    }
    if (row.rep.kind === "unattributed") {
      line.residue.push(row);
      continue;
    }
    const regionCode = row.rep.regionCode ?? "";
    let region = line.regions.get(regionCode);
    if (!region) {
      region = { regionCode, regionName: row.rep.regionName ?? "—", rows: [] };
      line.regions.set(regionCode, region);
    }
    region.rows.push(row);
  }

  const rows: WeeklyProductUnitsRow[] = [];
  const national = emptyBlocks();
  let repsWithSales = 0;
  const orderedLines = [...lines.values()].sort((a, b) => a.lineName.localeCompare(b.lineName));

  for (const line of orderedLines) {
    const lineTotal = emptyBlocks();
    const orderedRegions = [...line.regions.values()].sort(
      (a, b) =>
        regionOrder(a.regionCode) - regionOrder(b.regionCode) || a.regionName.localeCompare(b.regionName),
    );
    for (const region of orderedRegions) {
      const subtotal = emptyBlocks();
      // By AREA name: the names are frozen on the left of a wide grid, so a reader finds a person by
      // reading down them. Value order belongs on the Field Force league, which is a ranking.
      const areaRows = [...region.rows].sort((a, b) =>
        (a.rep.areaName ?? "~").localeCompare(b.rep.areaName ?? "~"),
      );
      for (const row of areaRows) {
        addInto(subtotal, row.blocks);
        if (row.sawSales && row.rep.kind === "rep") repsWithSales += 1;
        rows.push({
          areaCode: row.rep.areaCode,
          areaName: row.rep.areaName,
          growth: row.blocks.map((series) => growthOf(series)),
          kind: row.rep.kind === "vacant" ? "vacant" : "rep",
          key: row.rep.key,
          label: row.rep.label,
          lineCode: line.lineCode,
          lineName: line.lineName,
          managerName: row.rep.managerName,
          regionCode: region.regionCode,
          regionName: region.regionName,
          repName: row.rep.repName,
          units: row.blocks,
        });
      }
      addInto(lineTotal, subtotal);
      rows.push({
        areaCode: null,
        areaName: null,
        growth: subtotal.map((series) => growthOf(series)),
        kind: "regionSubtotal",
        key: `region:${line.lineCode}|${region.regionCode}`,
        label: `${region.regionName} total`,
        lineCode: line.lineCode,
        lineName: line.lineName,
        managerName: null,
        regionCode: region.regionCode,
        regionName: region.regionName,
        repName: null,
        units: subtotal,
      });
    }
    // The residue sits at the FOOT of its line, under its own name: it is that line's money, it
    // reached no area, and it is never folded into a region that did not earn it.
    for (const row of line.residue) {
      addInto(lineTotal, row.blocks);
      rows.push({
        areaCode: null,
        areaName: null,
        growth: row.blocks.map((series) => growthOf(series)),
        kind: "unattributed",
        key: row.rep.key,
        label: row.rep.label,
        lineCode: line.lineCode,
        lineName: line.lineName,
        managerName: null,
        regionCode: null,
        regionName: null,
        repName: null,
        units: row.blocks,
      });
    }
    addInto(national, lineTotal);
    rows.push({
      areaCode: null,
      areaName: null,
      growth: lineTotal.map((series) => growthOf(series)),
      kind: "lineSubtotal",
      key: `line:${line.lineCode}`,
      label: `${line.lineName} total`,
      lineCode: line.lineCode,
      lineName: line.lineName,
      managerName: null,
      regionCode: null,
      regionName: null,
      repName: null,
      units: lineTotal,
    });
  }

  // One grand total only where there is more than one line to add up. With a single line on screen it
  // would be the line total printed twice, which reads as a second, disagreeing figure.
  if (orderedLines.length > 1) {
    rows.push({
      areaCode: null,
      areaName: null,
      growth: national.map((series) => growthOf(series)),
      kind: "grandTotal",
      key: "grandTotal",
      label: "National total",
      lineCode: "",
      lineName: "",
      managerName: null,
      regionCode: null,
      regionName: null,
      repName: null,
      units: national,
    });
  }

  return {
    columns,
    months,
    emptyMonths,
    rows,
    totals: { value, exactValue, allocatedValue, unattributedValue, repsWithSales },
    seatIndexUnavailable,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/**
 * The product axis for the window: every product code that moved, ordered by VALUE, biggest first.
 *
 * Value and not units, because an axis ordered by units would rank a cheap high-count SKU above the
 * product that earns the line its money — and ordering by units would itself be comparing units of
 * different products, which is the one sum this module exists to refuse.
 */
export function weeklyProductUnitsAxis(rows: readonly WeeklyFactExportRow[]): Array<{
  code: string;
  name: string;
  value: number;
}> {
  const byCode = new Map<string, { code: string; name: string; units: number; value: number }>();
  for (const row of rows) {
    const code = String(row.productCode ?? "").trim();
    if (!code) continue;
    const entry =
      byCode.get(code) ?? { code, name: String(row.productName ?? "").trim() || code, units: 0, value: 0 };
    entry.value += Number(row.salesValue) || 0;
    entry.units += Number(row.salesUnits) || 0;
    byCode.set(code, entry);
  }
  return [...byCode.values()]
    // A product with no value but real units still earns a block — the price may simply be missing.
    .filter((entry) => entry.value !== 0 || entry.units !== 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .map((entry) => ({ code: entry.code, name: entry.name, value: entry.value }));
}

/**
 * Load the per-product units grid for the viewer's own scope.
 *
 * ONE row read covers every month in the window (`narrowRowsToCycleMonths` takes a list), then the
 * rows are partitioned by their own `cycleMonth` and each month is built through the SAME
 * `buildPortalWeeklyFieldForce` the Field Force tab uses — so a figure here and a figure there cannot
 * drift apart. Reading each month separately would have been N round trips for the same bytes.
 *
 * The load follows the viewer's own areas (own-area-share.ts), exactly as his Weekly Sales screen
 * does: a region-bound load never fetches the depot rows his split shares with a neighbour, and his
 * grid would read about zero. null when the viewer has no weekly access at all.
 */
export async function getPortalWeeklyProductUnits(
  ctx: AccessContext,
  options?: { cycleMonths?: string[] | null; months?: number },
): Promise<WeeklyProductUnitsMatrix | null> {
  const [accessScope, seatIndex] = await Promise.all([
    resolveWeeklyAccessScope(ctx),
    loadFieldForceSeatIndex(),
  ]);
  if (accessScope.tier === "none") return null;

  const areaSplitLoad = loadWeeklyAreaSplitIndex().catch(() => null);
  const ownAreaKeys = await resolveWeeklyOwnAreaKeys(ctx, accessScope, seatIndex.seats);
  const ownAreaShare = mayLiftWeeklyGeography(accessScope, ownAreaKeys)
    ? areaSplitLoad.then((areaSplit) => ({ ownAreaKeys, areaSplit, seatIndex }))
    : null;

  const asked = (options?.cycleMonths ?? [])
    .map(normalizeMonth)
    .filter((month): month is string => month !== null);
  let months = selectWeeklyProductUnitsMonths(asked, asked.length || WEEKLY_PRODUCT_UNITS_MONTHS);
  if (months.length === 0) {
    // Which months exist is itself a scoped read, so it is answered by a first pass that asks for no
    // row grain — cheap, and it keeps the window honest for a viewer whose line stopped uploading.
    const calendar = await loadWeeklyDashboard({ accessScope, allWeeks: true, excludeUnmapped: true });
    months = selectWeeklyProductUnitsMonths(
      calendar.availableMonths.map((month) => month.code),
      options?.months ?? WEEKLY_PRODUCT_UNITS_MONTHS,
    );
  }
  if (months.length === 0) {
    return buildWeeklyProductUnitsMatrix({
      perMonth: [],
      productAxis: [],
      seatIndexUnavailable: seatIndex.seats.length === 0,
    });
  }

  const [data, areaSplit] = await Promise.all([
    loadWeeklyDashboard({
      cycleMonths: months,
      cycleMonthMode: "include",
      // Only the grid is read, never the option lists, which is the precondition for narrowing the
      // fetch (see loadWeeklyDashboard's narrowRowsToCycleMonths).
      narrowRowsToCycleMonths: months,
      accessScope,
      allWeeks: true,
      // Rule 2 at the top of this file, and the module's own standing rule.
      excludeUnmapped: true,
      includeFactRows: true,
      // The cells are allocated shares of a depot, so most of them are fractions. Rounding each row
      // before they are added would lose a visible unit across a month of them.
      factRowsFullPrecision: true,
      ownAreaShare,
    }),
    areaSplitLoad,
  ]);

  const rows = data.factRows ?? [];
  const byMonth = new Map<string, WeeklyFactExportRow[]>(months.map((month) => [month, []]));
  for (const row of rows) {
    const month = normalizeMonth(row.cycleMonth);
    if (month === null) continue;
    byMonth.get(month)?.push(row);
  }

  const productAxis = weeklyProductUnitsAxis(rows);
  const perMonth = months.map((cycleMonth) => {
    const monthRows = byMonth.get(cycleMonth) ?? [];
    if (monthRows.length === 0) return { cycleMonth, grid: null };
    return {
      cycleMonth,
      grid: buildPortalWeeklyFieldForce({
        rows: monthRows,
        areaSplit,
        seatIndex,
        // The SHARED axis — the whole reason block N is the same product in every month.
        productAxis: productAxis.map((product) => ({ code: product.code, name: product.name })),
        depotWeekGaps: data.factRowDepotWeekGaps ?? [],
        seatIndexUnavailable: seatIndex.seats.length === 0,
      }),
    };
  });

  return buildWeeklyProductUnitsMatrix({
    perMonth,
    productAxis,
    seatIndexUnavailable: seatIndex.seats.length === 0,
  });
}
