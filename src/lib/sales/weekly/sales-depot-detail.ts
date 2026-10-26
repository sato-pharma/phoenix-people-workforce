// Weekly Sales — Depot Detail: the pure builder behind the detailed sales tables on both portal Weekly
// Sales screens (the managers' "Depot Detail" tab and a Medical Rep's own-area "Depot detail" tab).
//
// The owner asked for Weekly Sales "detailed exactly as Weekly Stock" (2026-09-16), so this mirrors
// stock-dashboard.ts table for table: one product at one depot, then By Product, By Depot, By Area,
// By Region and By Distributor, with the same filter cascade. Input is the weekly engine's own fact
// rows AFTER live price sync, de-cumulation, the viewer's access scope, the tracked-line golden rule
// and excludeUnmapped — see depot-detail-service.ts and portal-weekly-rep-depot-detail.ts. Everything
// here is in-memory and deterministic (tests/weekly-sales-depot-detail.test.ts).
//
// Owner rules this module encodes:
//   • The grain people read is ONE product code at ONE depot (in one area).
//   • Units are NEVER added across different product codes. A unit figure exists only on a cell and on
//     a product row; a depot, an area, a region, a distributor and the whole view are VALUE only. Beside
//     those values the screen shows ONE picked product's own units (weeklySalesDetailProductUnitsByGroup;
//     owner, 2026-09-19).
//   • A depot with no area mapping is reported under "Area not mapped", never dropped.
//   • A Medical Rep sees his own area's share of each depot and nothing wider. The caller hands in only
//     his parts, each labelled by how it reached him: mapped to his area by hand, or allocated to it by
//     the owner's depot-split rule. That label travels to every cell, so an allocation is never shown
//     as an observation.
//   • A manager reads whole depots — except a district or regional manager, who reads his own areas'
//     share (own-area-share.ts): a depot the split spreads over several areas reaches him only as the part
//     in his own areas, and that part carries the same "Allocated share" label a rep's does.
//
// AVERAGE PER WEEK IS GAP-AWARE. Most distributors restate the month to date, and de-cumulation
// subtracts each sheet from the previous PRESENT sheet of the month, so an upload that follows a missed
// week carries that week too, and the first upload of a month carries weeks 1..n. Twice-monthly
// distributors upload weeks 2 and 4 only. So a distributor's covered weeks are the week-of-month slots
// its uploads span, never a count of uploads — the same telescoping Weekly Stock's cover average uses.
// A non-cumulative distributor (Direct) and an untagged upload cover exactly one week each.

import { weeklyDistributorIsCumulative } from "@/lib/sales/weekly/distributors";
import { weeklyDistributorLabel } from "@/lib/sales/weekly/display-labels";
import type { WeeklyFilterMode } from "@/lib/sales/weekly/types";

/** Filter code for depots that carry no area mapping — the same code Weekly Stock uses. */
export const WEEKLY_SALES_DETAIL_UNMAPPED_AREA = "__unmapped__";
export const WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL = "Area not mapped";
/**
 * A depot whose upload names no region (the overseas distributor's "Unallocated POS") is filed here, never as
 * a row with no name. The Weekly Summarized Report calls the same rows "Region not mapped".
 */
export const WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL = "Region not mapped";
/** A client-side filter that resolved to nothing sends this, so the server returns nothing, not everything. */
export const WEEKLY_SALES_DETAIL_NOTHING = "__none__";

export type WeeklySalesDetailAudience = "manager" | "rep";

/** Net direction of a cell over the period: sold, or more came back than went out. */
export type WeeklySalesDetailMovement = "sold" | "returns";

export const WEEKLY_SALES_DETAIL_MOVEMENT_LABELS: Record<WeeklySalesDetailMovement, string> = {
  sold: "Sold",
  returns: "Net returns",
};

/**
 * How a figure reached the viewer.
 * whole     — a manager's row: the depot's whole sale, in the area the owner mapped it to (or none).
 * mapped    — a rep's row: the depot is mapped to his area by hand, so the whole sale is his.
 * allocated — a rep's row: the depot's name places it across several areas, and this is his share. Or a
 *             district or regional manager's row: the same kind of depot, and this is his own areas' share.
 * mixed     — a cell holding both kinds (the depot's mapping changed inside the period).
 */
export type WeeklySalesDetailBasis = "whole" | "mapped" | "allocated" | "mixed";

export const WEEKLY_SALES_DETAIL_BASIS_LABELS: Record<WeeklySalesDetailBasis, string> = {
  whole: "Whole branch",
  mapped: "Mapped by hand",
  allocated: "Allocated share",
  mixed: "Part allocated",
};

/**
 * Whether the view states how each figure reached the viewer: always for a rep, and for a manager only
 * when his own areas' share of a depot-split depot is in his view. The screen and the workbook both ask here,
 * so the download shows the basis exactly when the screen does.
 */
export function weeklySalesDetailShowsBasis(view: { audience: WeeklySalesDetailAudience; cells: readonly { basis: WeeklySalesDetailBasis }[] }): boolean {
  return view.audience === "rep" || view.cells.some((cell) => cell.basis === "allocated" || cell.basis === "mixed");
}

/** One de-cumulated, scoped fact row (a product at a depot in one upload), or a rep's part of one. */
export type WeeklySalesDetailSourceRow = {
  /** weekly_sales_batches.id — ties the row to its upload's week span */
  batchId: string;
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  /** The area's name when the caller already knows it (a rep's own seat); otherwise read from areaNames. */
  areaName?: string | null;
  branchCode: string;
  branchName: string;
  productCode: string;
  productName: string;
  line: string;
  cycleMonth: string;
  weekNumber: number | null;
  weekStart: string;
  salesValue: number;
  /** net units (sales less returns) */
  salesUnits: number;
  basis: Exclude<WeeklySalesDetailBasis, "mixed">;
};

/** One validated upload, whether or not any of its rows fall in the viewer's scope. */
export type WeeklySalesDetailUpload = {
  batchId: string;
  distributorCode: string;
  cycleMonth: string | null;
  weekNumber: number | null;
  weekStart: string | null;
};

/** The period the rows were loaded for. Decides which uploads count toward a distributor's weeks. */
export type WeeklySalesDetailPeriod = {
  cycleMonths?: string[] | null;
  cycleMonthMode?: WeeklyFilterMode | null;
  weekNumbers?: number[] | null;
  weekNumberMode?: WeeklyFilterMode | null;
};

/** Local filters, include-only (the client resolves an exclude choice to the codes it leaves). Empty = all. */
export type WeeklySalesDetailFilters = {
  /** Week of the month. Applied to rows AND to the upload calendar, so an average stays a true average. */
  weekNumbers?: number[] | null;
  distributorCodes?: string[] | null;
  /** Area codes, plus WEEKLY_SALES_DETAIL_UNMAPPED_AREA for depots with no area. */
  areaCodes?: string[] | null;
  /** Depot keys (see salesDepotKey). */
  branchKeys?: string[] | null;
  productCodes?: string[] | null;
  /** WeeklySalesDetailMovement values; anything else (WEEKLY_SALES_DETAIL_NOTHING) matches no cell. */
  movements?: string[] | null;
};

export type WeeklySalesDetailCell = {
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  areaName: string;
  branchKey: string;
  branchName: string;
  productCode: string;
  productName: string;
  line: string;
  /** net units of THIS product at this depot — the one grain where units are valid */
  units: number;
  value: number;
  /** units ÷ the distributor's covered weeks; null when no week is covered */
  avgWeeklyUnits: number | null;
  avgWeeklyValue: number | null;
  /** week slots in which this product sold here */
  weeksSold: number;
  /** week slots the distributor's uploads cover in the period */
  weeksCovered: number;
  /** share of the view's total value, 0–1; null when the total is not positive */
  share: number | null;
  movement: WeeklySalesDetailMovement;
  basis: WeeklySalesDetailBasis;
  /** the part of `value` placed by the depot-split rule (a rep's cell, or a district or regional manager's; 0 otherwise) */
  allocatedValue: number;
};

/** A product code across every in-view depot — the one place a unit total is valid. */
export type WeeklySalesDetailProductRow = {
  productCode: string;
  productName: string;
  line: string;
  units: number;
  value: number;
  avgWeeklyUnits: number;
  avgWeeklyValue: number;
  share: number | null;
  depotCount: number;
  soldDepots: number;
  returnsDepots: number;
};

/** Any grouping that spans several products — value only, never units. */
export type WeeklySalesDetailGroupRow = {
  code: string;
  name: string;
  /** what the row sits inside (a depot's region and distributor, an area's region); empty otherwise */
  parentName: string;
  value: number;
  avgWeeklyValue: number;
  share: number | null;
  productCount: number;
  soldCount: number;
  returnsCount: number;
  /** value of the cells that net to returns (a negative number, or 0) */
  returnsValue: number;
};

export type WeeklySalesDetailOption = { code: string; name: string };

export type WeeklySalesDetailView = {
  audience: WeeklySalesDetailAudience;
  kpis: {
    value: number;
    avgWeeklyValue: number;
    depotCount: number;
    productCount: number;
    /** mapped areas only; depots with no area are counted in unmappedValue */
    areaCount: number;
    regionCount: number;
    distributorCount: number;
    returnsCount: number;
    returnsValue: number;
    /** value of cells with no area mapping */
    unmappedValue: number;
    /** rep only: value from depots mapped to his area by hand (0 for a manager) */
    mappedValue: number;
    /** value the depot-split rule placed in the viewer's own area — a rep's, or a district or regional manager's own areas */
    allocatedValue: number;
    /** the most weeks any in-view distributor covers — the period's length in weeks */
    weeksCovered: number;
  };
  cells: WeeklySalesDetailCell[];
  products: WeeklySalesDetailProductRow[];
  depots: WeeklySalesDetailGroupRow[];
  areas: WeeklySalesDetailGroupRow[];
  /** managers only — a rep sees no region total, not even one that would only restate his own */
  regions: WeeklySalesDetailGroupRow[];
  distributors: WeeklySalesDetailGroupRow[];
  /** weeks the period's uploads cover — for the week filter */
  availableWeeks: WeeklySalesDetailOption[];
  availableDistributors: WeeklySalesDetailOption[];
  availableAreas: WeeklySalesDetailOption[];
  availableBranches: WeeklySalesDetailOption[];
  availableProducts: WeeklySalesDetailOption[];
};

/** Why a rep's detail has no numbers — the same states as his Weekly Sales page (portal-weekly-rep.ts). */
export type WeeklySalesDetailStatus = "ok" | "no_access" | "seat_index_unavailable" | "no_seat" | "no_data";

/** What both feeds return and both exports are built from. */
export type WeeklySalesDepotDetailPayload = {
  view: WeeklySalesDetailView;
  scope: {
    /** who the figures cover, in names */
    summary: string;
    /** the months and weeks the figures cover, in words */
    periodLabel: string;
  };
  /** Always "ok" for a manager. */
  status: WeeklySalesDetailStatus;
  /**
   * The depot-split index did not load: a rep then reads only the depots mapped to his area by hand, and a
   * district or regional manager reads no depot split — one filed under his own region whole, one filed
   * under another region not at all. False for every other manager.
   */
  allocationUnavailable: boolean;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-01" → "September 2026". A pure string parse, so no time zone can move the month. */
export function weeklySalesMonthLabel(cycleMonth: string): string {
  const [year, month] = (cycleMonth || "").split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name && year ? `${name} ${year}` : cycleMonth || "—";
}

const weekListLabel = (weeks: readonly number[]) =>
  [...weeks].sort((a, b) => a - b).map((week) => `Week ${week}`).join(", ");

/**
 * The period in words, for the workbook and the screen's footnote: "September 2026 · Week 1, Week 2".
 * `localWeeks` is a rep's own week filter; a list holding no real week reads "no weeks".
 */
export function weeklySalesPeriodLabel(period: WeeklySalesDetailPeriod, localWeeks?: readonly number[] | null): string {
  const months = [...new Set((period.cycleMonths ?? []).map((month) => month.trim()).filter(Boolean))].sort();
  const monthNames = months.map(weeklySalesMonthLabel).join(", ");
  const monthPart =
    months.length === 0 ? "All months" : period.cycleMonthMode === "exclude" ? `All months except ${monthNames}` : monthNames;
  const pageWeeks = (period.weekNumbers ?? []).filter((week) => Number.isFinite(week) && week > 0);
  let weekPart =
    pageWeeks.length === 0
      ? "all weeks"
      : period.weekNumberMode === "exclude"
        ? `all weeks except ${weekListLabel(pageWeeks)}`
        : weekListLabel(pageWeeks);
  if (localWeeks && localWeeks.length > 0) {
    const real = localWeeks.filter((week) => Number.isFinite(week) && week > 0);
    weekPart = real.length === 0 ? "no weeks" : weekListLabel(real);
  }
  return `${monthPart} · ${weekPart}`;
}

const up = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
/**
 * Rounds a figure for the screen, ONCE. Every total is built from unrounded figures and rounded at the end:
 * adding figures that were each rounded first drifts from the true total (a hundredth of a unit on a rep's
 * allocated quarters, pounds over a month of rows), and then this tab disagrees with the page it sits on.
 */
const round2 = (value: number) => Number(value.toFixed(2));
/** Anything smaller than half a piastre, or half a unit's hundredth, is a rounding residue, not a sale. */
const EPSILON = 0.005;

/** Stable depot identity inside one distributor: its code, or its name when it has no code. Same as Weekly Stock's. */
export function salesDepotKey(row: { distributorCode: string; branchCode: string; branchName: string }): string {
  return `${up(row.distributorCode)}|${up(row.branchCode) || up(row.branchName)}`;
}

/** Net direction of a period's figures. Units lead; a unit-less row (a value-only adjustment) reads its value. */
export function weeklySalesMovement(units: number, value: number): WeeklySalesDetailMovement {
  if (Math.abs(units) > EPSILON) return units > 0 ? "sold" : "returns";
  return value < 0 ? "returns" : "sold";
}

/**
 * The upload calendar: how many week-of-month slots each upload covers, and which upload its rows count under.
 *
 * `spans`, by batch id. Within one distributor's month, uploads are taken in the order de-cumulation
 * takes them (by date), and each spans from the week after the highest week already uploaded to its own
 * week — so week 3 after week 1 spans two, and a month whose first upload is week 3 spans three. What
 * arrives twice adds no week: a second sheet on the same date is merged into the first by
 * de-cumulation, and a later sheet restating a week already uploaded only corrects it. So a month's
 * spans add up to its highest week. A non-cumulative distributor (Direct) and an untagged upload cover
 * one week per date.
 *
 * `lead`, by batch id: the first upload of the same slot (itself when it is the first). De-cumulation
 * merges a same-date duplicate into rows that can carry EITHER batch id, so a sale is counted under its
 * slot's lead, which is the upload holding the slot's weeks.
 */
export function weeklySalesUploadCalendar(uploads: readonly WeeklySalesDetailUpload[]): {
  spans: Map<string, number>;
  lead: Map<string, string>;
} {
  const spans = new Map<string, number>();
  const lead = new Map<string, string>();
  const cycles = new Map<string, WeeklySalesDetailUpload[]>();
  const firstOnFlatDate = new Map<string, string>();
  for (const upload of uploads) {
    if (!upload.batchId || lead.has(upload.batchId)) continue;
    const date = (upload.weekStart ?? "").trim();
    if (!upload.cycleMonth || upload.weekNumber == null || !weeklyDistributorIsCumulative(upload.distributorCode)) {
      const slot = date ? `${up(upload.distributorCode)}||${date}` : "";
      const first = slot ? firstOnFlatDate.get(slot) : undefined;
      if (slot && !first) firstOnFlatDate.set(slot, upload.batchId);
      lead.set(upload.batchId, first ?? upload.batchId);
      spans.set(upload.batchId, first ? 0 : 1);
      continue;
    }
    lead.set(upload.batchId, upload.batchId);
    const key = `${up(upload.distributorCode)}||${upload.cycleMonth}`;
    const bucket = cycles.get(key) ?? [];
    bucket.push(upload);
    cycles.set(key, bucket);
  }
  for (const cycle of cycles.values()) {
    const ordered = [...cycle].sort(
      (a, b) => (a.weekStart ?? "").localeCompare(b.weekStart ?? "") || (a.weekNumber ?? 0) - (b.weekNumber ?? 0),
    );
    const firstOnDate = new Map<string, string>();
    const firstOfWeek = new Map<number, string>();
    let highest: number | null = null;
    for (const upload of ordered) {
      const date = (upload.weekStart ?? "").trim();
      const week = upload.weekNumber ?? 0;
      const slotLead = (date ? firstOnDate.get(date) : undefined) ?? firstOfWeek.get(week);
      if (slotLead) {
        lead.set(upload.batchId, slotLead);
        spans.set(upload.batchId, 0);
        continue;
      }
      if (date) firstOnDate.set(date, upload.batchId);
      firstOfWeek.set(week, upload.batchId);
      spans.set(upload.batchId, highest === null ? Math.max(1, week) : Math.max(0, week - highest));
      highest = highest === null ? week : Math.max(highest, week);
    }
  }
  return { spans, lead };
}

function passes(values: ReadonlySet<string>, mode: WeeklyFilterMode | null | undefined, value: string): boolean {
  if (values.size === 0) return true;
  return mode === "exclude" ? !values.has(value) : values.has(value);
}

/** True when the upload belongs to the period the rows were loaded for (the loader's own month/week rules). */
export function weeklySalesUploadInPeriod(upload: WeeklySalesDetailUpload, period: WeeklySalesDetailPeriod): boolean {
  const months = new Set((period.cycleMonths ?? []).map((month) => month.trim()).filter(Boolean));
  const weeks = new Set((period.weekNumbers ?? []).map((week) => String(week)));
  return (
    passes(months, period.cycleMonthMode, (upload.cycleMonth ?? "").trim()) &&
    passes(weeks, period.weekNumberMode, upload.weekNumber != null ? String(upload.weekNumber) : "")
  );
}

type CellAccumulator = {
  row: WeeklySalesDetailSourceRow;
  areaName: string;
  units: number;
  value: number;
  mappedValue: number;
  allocatedValue: number;
  hasWhole: boolean;
  /** a flag, not the value: an allocated sale and return can net to exactly nothing */
  hasAllocated: boolean;
  byUpload: Map<string, { units: number; value: number }>;
};

type GroupAccumulator = {
  code: string;
  name: string;
  parentName: string;
  value: number;
  avgWeeklyValue: number;
  products: Set<string>;
  soldCount: number;
  returnsCount: number;
  returnsValue: number;
};

/** A cell's figures before rounding: what every total is added from. */
type ExactFigures = {
  units: number;
  value: number;
  allocatedValue: number;
  avgWeeklyUnits: number | null;
  avgWeeklyValue: number | null;
};

function accumulate(
  map: Map<string, GroupAccumulator>,
  code: string,
  name: string,
  parentName: string,
  cell: WeeklySalesDetailCell,
  exact: ExactFigures,
) {
  const current =
    map.get(code) ??
    { code, name, parentName, value: 0, avgWeeklyValue: 0, products: new Set<string>(), soldCount: 0, returnsCount: 0, returnsValue: 0 };
  current.value += exact.value;
  current.avgWeeklyValue += exact.avgWeeklyValue ?? 0;
  current.products.add(cell.productCode);
  if (cell.movement === "returns") {
    current.returnsCount += 1;
    current.returnsValue += exact.value;
  } else {
    current.soldCount += 1;
  }
  map.set(code, current);
}

/** The tables that group several products — a branch, an area, a region, a distributor. */
export type WeeklySalesDetailGroupCut = "depots" | "areas" | "regions" | "distributors";

/** A cell's key in one grouping: exactly the `code` its group row carries. */
export function weeklySalesDetailGroupKey(
  cell: Pick<WeeklySalesDetailCell, "branchKey" | "areaCode" | "regionCode" | "regionName" | "distributorCode">,
  cut: WeeklySalesDetailGroupCut,
): string {
  if (cut === "depots") return cell.branchKey;
  // An unmapped branch is filed per region, so "Area not mapped" never reads as one place spanning the country.
  if (cut === "areas") return cell.areaCode ?? `${WEEKLY_SALES_DETAIL_UNMAPPED_AREA}|${up(cell.regionCode) || up(cell.regionName)}`;
  // "Region not mapped" keeps an empty code: the page has no region to filter to, so the row is not a drill.
  if (cut === "regions") {
    return cell.regionCode || (cell.regionName === WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL ? "" : up(cell.regionName));
  }
  return cell.distributorCode;
}

/** One product's own net units at one group. */
export type WeeklySalesDetailProductUnits = { units: number; avgWeeklyUnits: number };

/**
 * "Units for" (owner, 2026-09-19): a group row adds several products, so its value is the only total it
 * carries — but ONE product's units at each group are valid, and this is that product's net units and
 * average per week at every group, keyed as weeklySalesDetailGroupKey keys it. Built from the view's own
 * cells, so it follows every filter the rows do. A group the product never reached is absent (zero).
 */
export function weeklySalesDetailProductUnitsByGroup(
  cells: readonly WeeklySalesDetailCell[],
  productCode: string,
  cut: WeeklySalesDetailGroupCut,
): Record<string, WeeklySalesDetailProductUnits> {
  const code = up(productCode);
  const groups: Record<string, WeeklySalesDetailProductUnits> = {};
  for (const cell of cells) {
    if (up(cell.productCode) !== code) continue;
    const key = weeklySalesDetailGroupKey(cell, cut);
    const group = groups[key] ?? { units: 0, avgWeeklyUnits: 0 };
    group.units += cell.units;
    group.avgWeeklyUnits += cell.avgWeeklyUnits ?? 0;
    groups[key] = group;
  }
  for (const group of Object.values(groups)) {
    group.units = round2(group.units);
    group.avgWeeklyUnits = round2(group.avgWeeklyUnits);
  }
  return groups;
}

/** The "Units for" product: the one picked while the view still holds it, else the one with the most value. */
export function weeklySalesDetailUnitProduct(
  products: readonly WeeklySalesDetailProductRow[],
  pickedCode: string | null | undefined,
): WeeklySalesDetailProductRow | null {
  const picked = up(pickedCode);
  const found = picked ? products.find((product) => up(product.productCode) === picked) : undefined;
  if (found) return found;
  return [...products].sort((a, b) => b.value - a.value || a.productName.localeCompare(b.productName))[0] ?? null;
}

const shareOf = (value: number, total: number): number | null => (total > EPSILON ? value / total : null);

function finishGroups(map: Map<string, GroupAccumulator>, total: number): WeeklySalesDetailGroupRow[] {
  return [...map.values()]
    .map((group) => ({
      code: group.code,
      name: group.name,
      parentName: group.parentName,
      value: round2(group.value),
      avgWeeklyValue: round2(group.avgWeeklyValue),
      share: shareOf(group.value, total),
      productCount: group.products.size,
      soldCount: group.soldCount,
      returnsCount: group.returnsCount,
      returnsValue: round2(group.returnsValue),
    }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name) || a.parentName.localeCompare(b.parentName));
}

const byName = (a: WeeklySalesDetailOption, b: WeeklySalesDetailOption) => a.name.localeCompare(b.name);
const toOptions = (map: Map<string, string>) =>
  [...map.entries()].map(([code, name]) => ({ code, name })).sort(byName);
const includeSet = (values: readonly (string | number)[] | null | undefined) =>
  new Set((values ?? []).map((value) => up(String(value))).filter(Boolean));

export function buildWeeklySalesDepotDetail(input: {
  audience: WeeklySalesDetailAudience;
  rows: readonly WeeklySalesDetailSourceRow[];
  areaNames: ReadonlyMap<string, string>;
  /** Every validated upload of the months in play, whether or not its rows reach this viewer. */
  uploads: readonly WeeklySalesDetailUpload[];
  period?: WeeklySalesDetailPeriod;
  filters?: WeeklySalesDetailFilters;
}): WeeklySalesDetailView {
  const { audience, rows, areaNames } = input;
  const period = input.period ?? {};
  const filters = input.filters ?? {};

  // The calendar: every known upload, plus any upload a row came from that the list did not carry
  // (a row can never belong to no upload, so the average cannot silently lose a week).
  const uploadsById = new Map<string, WeeklySalesDetailUpload>();
  for (const upload of input.uploads) if (upload.batchId) uploadsById.set(upload.batchId, upload);
  for (const row of rows) {
    if (!row.batchId || uploadsById.has(row.batchId)) continue;
    uploadsById.set(row.batchId, {
      batchId: row.batchId,
      distributorCode: row.distributorCode,
      cycleMonth: row.cycleMonth || null,
      weekNumber: row.weekNumber,
      weekStart: row.weekStart || null,
    });
  }
  const calendar = weeklySalesUploadCalendar([...uploadsById.values()]);
  const { spans } = calendar;
  const slotOf = (batchId: string) => calendar.lead.get(batchId) ?? batchId;
  const rowBatchIds = new Set(rows.map((row) => row.batchId));
  const periodUploads = [...uploadsById.values()].filter(
    (upload) => rowBatchIds.has(upload.batchId) || weeklySalesUploadInPeriod(upload, period),
  );

  const weekFilter = includeSet(filters.weekNumbers);
  const weekOptions = new Set<number>();
  for (const upload of periodUploads) if (upload.weekNumber != null) weekOptions.add(upload.weekNumber);
  for (const row of rows) if (row.weekNumber != null) weekOptions.add(row.weekNumber);
  const weekPasses = (weekNumber: number | null) =>
    weekFilter.size === 0 || (weekNumber != null && weekFilter.has(String(weekNumber)));

  const coveredWeeksByDistributor = new Map<string, number>();
  for (const upload of periodUploads) {
    if (!weekPasses(upload.weekNumber)) continue;
    const key = up(upload.distributorCode);
    coveredWeeksByDistributor.set(key, (coveredWeeksByDistributor.get(key) ?? 0) + (spans.get(upload.batchId) ?? 1));
  }

  // Cells: one product at one depot in one area, summed over the period's uploads.
  const cellsByKey = new Map<string, CellAccumulator>();
  for (const row of rows) {
    if (!weekPasses(row.weekNumber)) continue;
    const areaCode = row.areaCode?.trim() ? row.areaCode.trim().toUpperCase() : null;
    const key = `${salesDepotKey(row)}|${up(row.productCode)}|${areaCode ?? WEEKLY_SALES_DETAIL_UNMAPPED_AREA}`;
    const areaName = areaCode
      ? row.areaName?.trim() || areaNames.get(areaCode) || areaCode
      : WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL;
    const current =
      cellsByKey.get(key) ??
      { row, areaName, units: 0, value: 0, mappedValue: 0, allocatedValue: 0, hasWhole: false, hasAllocated: false, byUpload: new Map() };
    const value = Number(row.salesValue) || 0;
    const units = Number(row.salesUnits) || 0;
    current.units += units;
    current.value += value;
    if (row.basis === "allocated") {
      current.allocatedValue += value;
      current.hasAllocated = true;
    } else if (row.basis === "mapped") current.mappedValue += value;
    else current.hasWhole = true;
    const slot = slotOf(row.batchId);
    const perUpload = current.byUpload.get(slot) ?? { units: 0, value: 0 };
    perUpload.units += units;
    perUpload.value += value;
    current.byUpload.set(slot, perUpload);
    // The newest row names the depot and its region as they read today.
    if ((row.weekStart ?? "") >= (current.row.weekStart ?? "")) {
      current.row = row;
      current.areaName = areaName;
    }
    cellsByKey.set(key, current);
  }

  const allEntries: { cell: WeeklySalesDetailCell; exact: ExactFigures }[] = [];
  for (const cell of cellsByKey.values()) {
    if (Math.abs(cell.units) <= EPSILON && Math.abs(cell.value) <= EPSILON) continue;
    const { row } = cell;
    const weeksCovered = coveredWeeksByDistributor.get(up(row.distributorCode)) ?? 0;
    let weeksSold = 0;
    for (const [batchId, figures] of cell.byUpload) {
      if (weeklySalesMovement(figures.units, figures.value) === "sold" && (figures.units > EPSILON || figures.value > EPSILON)) {
        weeksSold += spans.get(batchId) ?? 1;
      }
    }
    // A manager's cell is whole unless his own areas' share of a depot-split depot is in it; a rep's keeps its own rule.
    const basis: WeeklySalesDetailBasis =
      audience === "manager"
        ? cell.hasAllocated
          ? cell.hasWhole
            ? "mixed"
            : "allocated"
          : "whole"
        : cell.hasWhole
          ? "whole"
          : Math.abs(cell.allocatedValue) <= EPSILON
            ? "mapped"
            : Math.abs(cell.mappedValue) <= EPSILON
              ? "allocated"
              : "mixed";
    const exact: ExactFigures = {
      units: cell.units,
      value: cell.value,
      allocatedValue: cell.allocatedValue,
      avgWeeklyUnits: weeksCovered > 0 ? cell.units / weeksCovered : null,
      avgWeeklyValue: weeksCovered > 0 ? cell.value / weeksCovered : null,
    };
    allEntries.push({
      exact,
      cell: {
        distributorCode: up(row.distributorCode),
        distributorName: row.distributorName || row.distributorCode,
        regionCode: up(row.regionCode),
        regionName: row.regionName || row.regionCode || WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL,
        areaCode: row.areaCode?.trim() ? row.areaCode.trim().toUpperCase() : null,
        areaName: cell.areaName,
        branchKey: salesDepotKey(row),
        branchName: row.branchName || row.branchCode,
        productCode: up(row.productCode),
        productName: row.productName || row.productCode,
        line: row.line,
        units: round2(exact.units),
        value: round2(exact.value),
        avgWeeklyUnits: exact.avgWeeklyUnits == null ? null : round2(exact.avgWeeklyUnits),
        avgWeeklyValue: exact.avgWeeklyValue == null ? null : round2(exact.avgWeeklyValue),
        weeksSold,
        weeksCovered,
        share: null,
        movement: weeklySalesMovement(cell.units, cell.value),
        basis,
        allocatedValue: round2(exact.allocatedValue),
      },
    });
  }

  // The filter cascade, in Weekly Stock's order: each option list is read before its own filter, so
  // picking one value never hides the others from the same list.
  const distributorFilter = includeSet(filters.distributorCodes);
  const areaFilter = includeSet(filters.areaCodes);
  const branchFilter = includeSet(filters.branchKeys);
  const productFilter = includeSet(filters.productCodes);
  const movementFilter = new Set<string>((filters.movements ?? []).map((movement) => movement.trim()).filter(Boolean));
  const distributorOptions = new Map<string, string>();
  const areaOptions = new Map<string, string>();
  const branchOptions = new Map<string, string>();
  const productOptions = new Map<string, string>();

  const entries = allEntries
    .filter(({ cell }) => {
      distributorOptions.set(cell.distributorCode, cell.distributorName);
      if (distributorFilter.size > 0 && !distributorFilter.has(cell.distributorCode)) return false;
      areaOptions.set(cell.areaCode ?? WEEKLY_SALES_DETAIL_UNMAPPED_AREA, cell.areaName);
      if (areaFilter.size > 0 && !areaFilter.has(up(cell.areaCode ?? WEEKLY_SALES_DETAIL_UNMAPPED_AREA))) return false;
      branchOptions.set(cell.branchKey, `${cell.branchName} · ${weeklyDistributorLabel(cell.distributorName, cell.distributorCode)}`);
      if (branchFilter.size > 0 && !branchFilter.has(up(cell.branchKey))) return false;
      productOptions.set(cell.productCode, cell.productName);
      if (productFilter.size > 0 && !productFilter.has(cell.productCode)) return false;
      if (movementFilter.size > 0 && !movementFilter.has(cell.movement)) return false;
      return true;
    })
    .sort(
      ({ cell: a }, { cell: b }) =>
        a.regionName.localeCompare(b.regionName) ||
        a.areaName.localeCompare(b.areaName) ||
        a.branchName.localeCompare(b.branchName) ||
        a.distributorName.localeCompare(b.distributorName) ||
        a.productName.localeCompare(b.productName),
    );
  const cells = entries.map((entry) => entry.cell);

  const totalValue = entries.reduce((sum, entry) => sum + entry.exact.value, 0);
  for (const { cell, exact } of entries) cell.share = shareOf(exact.value, totalValue);

  const products = new Map<string, WeeklySalesDetailProductRow>();
  const depots = new Map<string, GroupAccumulator>();
  const areas = new Map<string, GroupAccumulator>();
  const regions = new Map<string, GroupAccumulator>();
  const distributors = new Map<string, GroupAccumulator>();
  const depotKeys = new Set<string>();
  const areaKeys = new Set<string>();
  let unmappedValue = 0;
  let mappedValue = 0;
  let allocatedValue = 0;
  let returnsValue = 0;
  let returnsCount = 0;

  for (const { cell, exact } of entries) {
    depotKeys.add(cell.branchKey);
    if (cell.areaCode) areaKeys.add(cell.areaCode);
    else unmappedValue += exact.value;
    if (cell.basis !== "whole") {
      allocatedValue += exact.allocatedValue;
      // A manager's "mixed" cell holds whole-depot value beside the share, and none of it is mapped by hand.
      if (audience === "rep") mappedValue += exact.value - exact.allocatedValue;
    }
    if (cell.movement === "returns") {
      returnsCount += 1;
      returnsValue += exact.value;
    }

    const product =
      products.get(cell.productCode) ??
      {
        productCode: cell.productCode,
        productName: cell.productName,
        line: cell.line,
        units: 0,
        value: 0,
        avgWeeklyUnits: 0,
        avgWeeklyValue: 0,
        share: null,
        depotCount: 0,
        soldDepots: 0,
        returnsDepots: 0,
      };
    product.units += exact.units;
    product.value += exact.value;
    product.avgWeeklyUnits += exact.avgWeeklyUnits ?? 0;
    product.avgWeeklyValue += exact.avgWeeklyValue ?? 0;
    product.depotCount += 1;
    if (cell.movement === "returns") product.returnsDepots += 1;
    else product.soldDepots += 1;
    products.set(cell.productCode, product);

    const depotParent =
      audience === "rep" ? cell.distributorName : [cell.regionName, cell.distributorName].filter(Boolean).join(" · ");
    // One key per grouping (weeklySalesDetailGroupKey), shared with the "Units for" column beside each row.
    accumulate(depots, weeklySalesDetailGroupKey(cell, "depots"), cell.branchName, depotParent, cell, exact);
    accumulate(areas, weeklySalesDetailGroupKey(cell, "areas"), cell.areaName, cell.regionName, cell, exact);
    if (audience === "manager") accumulate(regions, weeklySalesDetailGroupKey(cell, "regions"), cell.regionName, "", cell, exact);
    accumulate(distributors, weeklySalesDetailGroupKey(cell, "distributors"), cell.distributorName, "", cell, exact);
  }

  const productRows = [...products.values()]
    .map((product) => ({
      ...product,
      units: round2(product.units),
      value: round2(product.value),
      avgWeeklyUnits: round2(product.avgWeeklyUnits),
      avgWeeklyValue: round2(product.avgWeeklyValue),
      share: shareOf(product.value, totalValue),
    }))
    .sort((a, b) => a.line.localeCompare(b.line) || a.productName.localeCompare(b.productName));

  const inViewDistributors = new Set(cells.map((cell) => cell.distributorCode));
  const weeksCovered = Math.max(
    0,
    ...[...coveredWeeksByDistributor.entries()]
      .filter(([code]) => inViewDistributors.has(code))
      .map(([, weeks]) => weeks),
  );

  return {
    audience,
    kpis: {
      value: round2(totalValue),
      avgWeeklyValue: round2(entries.reduce((sum, entry) => sum + (entry.exact.avgWeeklyValue ?? 0), 0)),
      depotCount: depotKeys.size,
      productCount: products.size,
      areaCount: areaKeys.size,
      regionCount: new Set(cells.map((cell) => cell.regionCode || up(cell.regionName))).size,
      distributorCount: inViewDistributors.size,
      returnsCount,
      returnsValue: round2(returnsValue),
      unmappedValue: round2(unmappedValue),
      mappedValue: round2(mappedValue),
      allocatedValue: round2(allocatedValue),
      weeksCovered,
    },
    cells,
    products: productRows,
    depots: finishGroups(depots, totalValue),
    areas: finishGroups(areas, totalValue),
    regions: finishGroups(regions, totalValue),
    distributors: finishGroups(distributors, totalValue),
    availableWeeks: [...weekOptions]
      .sort((a, b) => a - b)
      .map((week) => ({ code: String(week), name: `Week ${week}` })),
    availableDistributors: toOptions(distributorOptions),
    availableAreas: toOptions(areaOptions),
    availableBranches: toOptions(branchOptions),
    availableProducts: toOptions(productOptions),
  };
}
