// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the forecast as a file: an Excel workbook or a PDF.
//
// Owner request 2026-09-14: "able to export xlsx forecast or polish pdf".
//
// ONE MODEL, TWO RENDERINGS, AND THE SCREEN'S OWN FUNCTIONS. The model below is built with the same
// `filterPlanLines`, `rowFigures` and `buildPlanScenarios` the planner renders with, over a workspace
// the route rebuilt for the caller — so a file cannot show a product, a gap or a scenario the screen
// did not. A filtered file says so on its first page, in the words the filter chips use.
//
// Units are never totalled across products: every total row carries VALUE and leaves units empty.
// Both files wear the house identity, SATO-DIS-2026-01 v1.0 — ink, not fills, except the 6% zebra.
// This module is pure (no browser, no database); the route owns Chromium.
// ─────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { HOUSE_COLORS, HOUSE_IDENTITY_CSS } from "@/lib/hiring-pack/house-identity";
import { satoLogoDataUri } from "@/lib/offers/brand";
import {
  HONESTY_SENTENCE,
  achievementOf,
  brickUnitsFor,
  type MakeItHappenWorkspace,
} from "@/lib/sales/make-it-happen/engine";
import {
  buildPlanScenarios,
  describePlannerFilters,
  filterPlanLines,
  pediaHalves,
  scenarioSummary,
  trendLabel,
  type FilteredLine,
  type GoalCheck,
  type PlanScenario,
  type PlannerFilters,
} from "@/lib/sales/make-it-happen/scenarios";

export type ForecastExportFormat = "xlsx" | "pdf";

export function isForecastExportFormat(value: unknown): value is ForecastExportFormat {
  return value === "xlsx" || value === "pdf";
}

export type ForecastExportLine = FilteredLine & {
  /** Whole-line figures — a filter narrows the rows shown, never the line's own totals. */
  forecastValue: number;
  achievement: number | null;
  gapValue: number | null;
};

export type ForecastExportModel = {
  periodLabel: string;
  scopeLabel: string;
  goalPct: number;
  generatedAtLabel: string;
  filterNote: string | null;
  totals: {
    targetValue: number | null;
    gradedValue: number;
    forecastValue: number;
    achievement: number | null;
    gapValue: number | null;
  };
  lines: ForecastExportLine[];
  /** The two Pedia halves on this forecast, Sato first — empty for every plan without Pedia. */
  halves: GoalCheck[];
  scenarios: PlanScenario[];
  shownRows: number;
  totalRows: number;
  /** engine.ts rule 9 — each shown product's forecast per brick, biggest pace first. */
  bricks: Record<string, ForecastBrick[]>;
};

export type ForecastBrick = {
  name: string;
  units: number;
  value: number;
  /** Who covers the brick (engine.ts BrickPlanRow): null = vacant seat / no District Manager. */
  repName?: string | null;
  districtManagerName?: string | null;
  /** Where the brick sits (engine.ts BrickPlanRow): null = not known. */
  areaName?: string | null;
  regionName?: string | null;
};

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function money(value: number): string {
  return `EGP ${INTEGER.format(Math.round(value))}`;
}

function pct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** Cairo local, the way every other Phoenix document states when it was made. */
export function cairoStamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

export function buildForecastExportModel(input: {
  workspace: MakeItHappenWorkspace;
  units: Record<string, number>;
  /** product_code → brick_id → units as typed; a product left out is split by its bricks' pace. */
  bricks?: Record<string, Record<string, number>>;
  goalPct: number;
  filters: PlannerFilters;
  now: Date;
}): ForecastExportModel {
  const { workspace, units, goalPct, filters } = input;
  const filtered = filterPlanLines(workspace.lines, filters, units);

  const lines: ForecastExportLine[] = filtered.map((entry) => {
    const open = entry.line.remainingMonths > 0;
    const forecastValue = open
      ? entry.line.rows.reduce((sum, row) => sum + (units[row.productCode] ?? 0) * row.price, 0)
      : 0;
    return {
      ...entry,
      forecastValue,
      achievement: achievementOf(entry.line.gradedValue, forecastValue, entry.line.targetValue),
      gapValue: entry.line.targetValue == null ? null : entry.line.targetValue - entry.line.gradedValue - forecastValue,
    };
  });

  // Whole-plan totals, from every line — filtered away or not — exactly as the screen's band shows.
  const forecastValue = workspace.lines.reduce(
    (sum, line) =>
      line.remainingMonths > 0 ? sum + line.rows.reduce((inner, row) => inner + (units[row.productCode] ?? 0) * row.price, 0) : sum,
    0,
  );
  const { targetValue, gradedValue } = workspace.totals;
  const bricks: ForecastExportModel["bricks"] = {};
  for (const entry of lines) {
    if (entry.line.remainingMonths <= 0) continue;
    for (const { row } of entry.rows) {
      if (row.bricks.length === 0) continue;
      const split = brickUnitsFor(row.bricks, units[row.productCode] ?? 0, input.bricks?.[row.productCode]);
      bricks[row.productCode] = row.bricks.map((brick) => ({
        name: brick.name,
        units: split[brick.brickId] ?? 0,
        value: (split[brick.brickId] ?? 0) * row.price,
        ...(brick.repName !== undefined ? { repName: brick.repName } : {}),
        ...(brick.districtManagerName !== undefined ? { districtManagerName: brick.districtManagerName } : {}),
        ...(brick.areaName !== undefined ? { areaName: brick.areaName } : {}),
        ...(brick.regionName !== undefined ? { regionName: brick.regionName } : {}),
      }));
    }
  }
  const lineNames = new Map(workspace.lines.map((line) => [line.lineCode, line.lineName]));

  return {
    periodLabel: workspace.periodLabel,
    scopeLabel: workspace.viewingRep ? workspace.viewingRep.name : workspace.scopeLabel,
    goalPct,
    generatedAtLabel: cairoStamp(input.now),
    filterNote: describePlannerFilters(filters, lineNames),
    totals: {
      targetValue,
      gradedValue,
      forecastValue,
      achievement: achievementOf(gradedValue, forecastValue, targetValue),
      gapValue: targetValue == null ? null : targetValue - gradedValue - forecastValue,
    },
    // Lines the filter emptied are dropped from the file, as they are from the screen.
    lines: lines.filter((line) => line.rows.length > 0),
    halves: pediaHalves(workspace, units, goalPct),
    scenarios: buildPlanScenarios(workspace, goalPct),
    shownRows: filtered.reduce((sum, line) => sum + line.rows.length, 0),
    totalRows: workspace.lines.reduce((sum, line) => sum + line.rows.length, 0),
    bricks,
  };
}

/** "Q3 2026 · July to September" → "q3-2026-july-to-september". Names, never codes. */
export function forecastExportFilename(model: ForecastExportModel, format: ForecastExportFormat): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const parts = ["make-it-happen", slug(model.periodLabel), slug(model.scopeLabel)].filter(Boolean);
  return `${parts.join("-")}.${format}`;
}

function gapText(gap: number | null): string {
  if (gap == null) return "No target";
  return gap > 0 ? `${money(gap)} to go` : gap < 0 ? `${money(-gap)} above` : "Met";
}

/** "54.8% of its own target · EGP 1,234 short of the 100% goal" — one Pedia half, in words. */
export function halfText(half: GoalCheck, goalPct: number): string {
  if (half.targetValue == null) return "No target";
  const standing =
    half.reachesGoal === false ? `${money(half.shortOfGoal ?? 0)} short of the ${goalPct}% goal` : `reaches the ${goalPct}% goal`;
  return `${pct(half.achievement)} of its own target · ${standing}`;
}

/** Said on every page that states a Pedia half. */
const HALVES_NOTE =
  "Pedia is paid on two halves: one month of basic on the Sato products against their own target, one on the whole line. Other products lift only the total half. Below 90% a half pays nothing.";

/** The line note, naming the open months that carry no target and so are not forecast. */
function forecastNote(line: ForecastExportLine["line"]): string {
  const untargeted =
    line.untargetedMonthLabels.length > 0
      ? ` ${line.untargetedMonthLabels.join(", ")} carry no target yet and are not forecast.`
      : "";
  if (line.remainingMonths > 0) return `Forecasting ${line.forecastMonthLabels.join(", ")}.${untargeted}`;
  return untargeted ? `No open month carries a target yet.${untargeted}` : "Every month of this period is closed for this line.";
}

// ── The team's levels: District Managers, Medical Reps, Bricks ──────────────
//
// Owner, 2026-11-14, first: "make it simply per DSM (I mean tab by brick) firstly then per MR, not by
// brick name only". Then, the same day: "if national sales manager or regional manager have a tab
// called district managers and have his managers under it. Same for medical reps. Then for bricks …
// start from the big region or national region area brick." So the workbook carries one tab per LEVEL:
// "District Managers" (each manager on a row), "Medical Reps" (each manager's reps in a table) and
// "Bricks" (Region → Area → Brick, biggest level first). A level tab appears only when the file holds
// more than one of that level — a District Manager's own file has no District Managers tab, a rep's
// file only the Bricks tab. Each brick sits under the rep, District Manager, area and region of the
// latest closed month it sold in (workspace.ts brickCover). Every total is VALUE: units of different
// products are never added.

export const NO_DISTRICT_MANAGER = "No District Manager";
export const VACANT_SEAT = "Vacant seat";
export const NO_REGION = "No region";
export const NO_AREA = "No area";
export const DISTRICT_MANAGERS_TAB = "District Managers";
export const MEDICAL_REPS_TAB = "Medical Reps";
export const BRICKS_TAB = "Bricks";

export type BrickTabRow = {
  brick: string;
  product: string;
  units: number;
  value: number;
  rep: string;
  districtManager: string;
  area: string;
  region: string;
};
export type BrickRepBlock = {
  name: string;
  lineName: string;
  bricks: number;
  value: number;
  /** The areas this rep's bricks sit in, by name. */
  areas: string[];
  rows: BrickTabRow[];
};
export type BrickDistrictTab = { name: string; value: number; reps: BrickRepBlock[] };

/** Names first, the unnamed buckets last — "Vacant seat" and "No District Manager" sit at the end. */
function byNameLast(last: string) {
  return (a: { name: string }, b: { name: string }) =>
    Number(a.name === last) - Number(b.name === last) || a.name.localeCompare(b.name);
}

function distinctSorted(values: Iterable<string>, last: string): string[] {
  return [...new Set(values)].sort((a, b) => Number(a === last) - Number(b === last) || a.localeCompare(b));
}

export function groupBricksByDistrict(model: Pick<ForecastExportModel, "lines" | "bricks">): BrickDistrictTab[] {
  const districts = new Map<string, Map<string, BrickRepBlock>>();
  for (const line of model.lines) {
    for (const { row: product } of line.rows) {
      for (const brick of model.bricks[product.productCode] ?? []) {
        const districtName = brick.districtManagerName || NO_DISTRICT_MANAGER;
        const repName = brick.repName || VACANT_SEAT;
        const reps = districts.get(districtName) ?? new Map<string, BrickRepBlock>();
        districts.set(districtName, reps);
        const repKey = `${line.line.lineName}|${repName}`;
        const block = reps.get(repKey) ?? { name: repName, lineName: line.line.lineName, bricks: 0, value: 0, areas: [], rows: [] };
        reps.set(repKey, block);
        block.rows.push({
          brick: brick.name,
          product: product.name,
          units: brick.units,
          value: brick.value,
          rep: repName,
          districtManager: districtName,
          area: brick.areaName || NO_AREA,
          region: brick.regionName || NO_REGION,
        });
        block.value += brick.value;
      }
    }
  }
  const tabs: BrickDistrictTab[] = [];
  for (const [name, reps] of districts) {
    const blocks = [...reps.values()];
    for (const block of blocks) {
      // A rep's bricks together, by name; the sort is stable, so each brick's products keep the
      // plan's own product order.
      block.rows.sort((a, b) => a.brick.localeCompare(b.brick, "ar"));
      block.bricks = new Set(block.rows.map((row) => row.brick)).size;
      block.areas = distinctSorted(block.rows.map((row) => row.area), NO_AREA);
    }
    blocks.sort((a, b) => byNameLast(VACANT_SEAT)(a, b) || a.lineName.localeCompare(b.lineName));
    tabs.push({ name, value: blocks.reduce((sum, block) => sum + block.value, 0), reps: blocks });
  }
  return tabs.sort(byNameLast(NO_DISTRICT_MANAGER));
}

export type BrickArea = { name: string; value: number; bricks: number; reps: string[]; districtManagers: string[]; rows: BrickTabRow[] };
export type BrickRegion = { name: string; value: number; bricks: number; areas: BrickArea[] };
export type BrickLineRegions = { lineName: string; value: number; regions: BrickRegion[] };

const countBricks = (rows: readonly BrickTabRow[]) => new Set(rows.map((row) => `${row.area}|${row.brick}`)).size;

/** The Bricks tab, biggest level first: each line's regions, each region's areas, each area's bricks. */
export function groupBricksByRegion(model: Pick<ForecastExportModel, "lines" | "bricks">): BrickLineRegions[] {
  const byLine = new Map<string, BrickTabRow[]>();
  for (const district of groupBricksByDistrict(model)) {
    for (const rep of district.reps) {
      const rows = byLine.get(rep.lineName) ?? [];
      rows.push(...rep.rows);
      byLine.set(rep.lineName, rows);
    }
  }
  const out: BrickLineRegions[] = [];
  for (const line of model.lines) {
    const rows = byLine.get(line.line.lineName);
    if (!rows) continue;
    const regions = new Map<string, Map<string, BrickTabRow[]>>();
    for (const row of rows) {
      const areas = regions.get(row.region) ?? new Map<string, BrickTabRow[]>();
      regions.set(row.region, areas);
      areas.set(row.area, [...(areas.get(row.area) ?? []), row]);
    }
    const regionList: BrickRegion[] = [...regions].map(([regionName, areas]) => {
      const areaList: BrickArea[] = [...areas].map(([areaName, areaRows]) => {
        // An area's bricks by name, each brick's products together in the plan's product order.
        const sorted = [...areaRows].sort((a, b) => a.brick.localeCompare(b.brick, "ar"));
        return {
          name: areaName,
          value: sorted.reduce((sum, row) => sum + row.value, 0),
          bricks: countBricks(sorted),
          reps: distinctSorted(sorted.map((row) => row.rep), VACANT_SEAT),
          districtManagers: distinctSorted(sorted.map((row) => row.districtManager), NO_DISTRICT_MANAGER),
          rows: sorted,
        };
      });
      areaList.sort(byNameLast(NO_AREA));
      return {
        name: regionName,
        value: areaList.reduce((sum, area) => sum + area.value, 0),
        bricks: areaList.reduce((sum, area) => sum + area.bricks, 0),
        areas: areaList,
      };
    });
    regionList.sort(byNameLast(NO_REGION));
    out.push({ lineName: line.line.lineName, value: regionList.reduce((sum, region) => sum + region.value, 0), regions: regionList });
  }
  return out;
}

// ── Excel ────────────────────────────────────────────────────────────────────

const MONEY_FMT = '#,##0;[Red]-#,##0';
const UNITS_FMT = "#,##0";
const PCT_FMT = "0.0%";

export async function buildForecastWorkbook(model: ForecastExportModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  buildHouseCoverSheet(workbook, {
    title: "Make It Happen forecast",
    subtitle: `${model.periodLabel} · ${model.scopeLabel}`,
    confidentialNote:
      "Confidential. Target, sales and forecast values for the scope named below. Units are never added across different products; every total is value.",
    rows: [
      ["Period", model.periodLabel],
      ["Scope", model.scopeLabel],
      ["Achievement goal", `${model.goalPct}% of target`],
      ["Target", model.totals.targetValue == null ? "No target set for this period" : money(model.totals.targetValue)],
      ["Sold so far", `${money(model.totals.gradedValue)} (closed months only)`],
      ["Your forecast", money(model.totals.forecastValue)],
      ["Forecast achievement", pct(model.totals.achievement)],
      ["Gap to target", gapText(model.totals.gapValue)],
      ...model.halves.map((half): [string, string] => [half.label, halfText(half, model.goalPct)]),
      ...(model.halves.length > 0 ? [["How Pedia is paid", HALVES_NOTE] as [string, string]] : []),
      ["Filters", model.filterNote ?? "None. This file covers every product in the plan."],
      ["Products in this file", `${INTEGER.format(model.shownRows)} of ${INTEGER.format(model.totalRows)}`],
      ["Generated", `${model.generatedAtLabel} (Cairo)`],
    ],
    emphasise: (key) => key === "Filters" && model.filterNote != null,
  });

  const forecast = workbook.addWorksheet("Forecast", { properties: { defaultRowHeight: 18 } });
  forecast.views = [{ showGridLines: false }];
  const forecastColumns: TableColumn[] = [
    { label: "Product", width: 30 },
    { label: "Family", width: 18 },
    { label: "Trend", width: 22 },
    { label: "Price a unit", numFmt: MONEY_FMT, right: true, width: 12 },
    { label: "Target units", numFmt: UNITS_FMT, right: true, width: 12 },
    { label: "Target value", numFmt: MONEY_FMT, right: true, width: 14 },
    { label: "Sold units", numFmt: UNITS_FMT, right: true, width: 11 },
    { label: "Sold value", numFmt: MONEY_FMT, right: true, width: 14 },
    { label: "Forecast units", numFmt: UNITS_FMT, right: true, width: 12 },
    { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 14 },
    { label: "Achievement", numFmt: PCT_FMT, right: true, width: 12 },
    { label: "Gap to target (value)", numFmt: MONEY_FMT, right: true, width: 16 },
    { label: "Gap to target (units)", numFmt: UNITS_FMT, right: true, width: 16 },
  ];

  let row = 1;
  if (model.filterNote) {
    forecast.getCell(row, 1).value = model.filterNote;
    forecast.getCell(row, 1).font = { bold: true, color: { argb: "FFB3312C" } };
    row += 2;
  }
  if (model.lines.length === 0) {
    forecast.getCell(row, 1).value = "No product matches these filters.";
  }
  for (const line of model.lines) {
    const rows: CellValue[][] = line.rows.map(({ row: product, figures }) => [
      product.name,
      product.family || "—",
      trendLabel(product.trend),
      product.price,
      product.targetUnits,
      product.targetValue,
      product.gradedUnits,
      product.gradedValue,
      figures.typedUnits,
      figures.value,
      figures.achievement,
      figures.gapValue,
      figures.gapUnits,
    ]);
    row = writeHouseTable(forecast, row, {
      columns: forecastColumns,
      rows,
      title: `${line.line.lineName}${line.rows.length < line.totalRows ? ` · ${line.rows.length} of ${line.totalRows} products` : ""}`,
      // Value only on the total row: units of different products are never added.
      totals: [
        `${line.line.lineName} total (whole line)`,
        null,
        null,
        null,
        null,
        line.line.targetValue,
        null,
        line.line.gradedValue,
        null,
        line.forecastValue,
        line.achievement,
        line.gapValue,
        null,
      ],
      note: forecastNote(line.line),
    });
  }

  // engine.ts rule 9 — the forecast per brick, one tab per LEVEL (owner, 2026-11-14): District
  // Managers, then Medical Reps, then Bricks from region down to brick. A product's bricks still add
  // up to its units; units are never totalled across products, so every total row is value.
  const levelTab = (name: string) => {
    const tab = workbook.addWorksheet(name, { properties: { defaultRowHeight: 18 } });
    tab.views = [{ showGridLines: false }];
    let first = 1;
    if (model.filterNote) {
      tab.getCell(first, 1).value = model.filterNote;
      tab.getCell(first, 1).font = { bold: true, color: { argb: "FFB3312C" } };
      first += 2;
    }
    return { tab, first };
  };
  const districts = groupBricksByDistrict(model);
  const repCount = districts.reduce((sum, district) => sum + district.reps.length, 0);
  const COVER_NOTE =
    "Each brick sits under the rep, District Manager, area and region of the latest closed month it sold in.";

  if (districts.length > 1) {
    const { tab, first } = levelTab(DISTRICT_MANAGERS_TAB);
    let tabRow = first;
    for (const line of model.lines) {
      const managers = districts
        .map((district) => ({ district, reps: district.reps.filter((rep) => rep.lineName === line.line.lineName) }))
        .filter((entry) => entry.reps.length > 0);
      if (managers.length === 0) continue;
      const rows = managers.map(({ district, reps }) => {
        const brickRows = reps.flatMap((rep) => rep.rows);
        return [
          district.name,
          distinctSorted(brickRows.map((row) => row.region), NO_REGION).join(", "),
          reps.filter((rep) => rep.name !== VACANT_SEAT).length,
          countBricks(brickRows),
          reps.reduce((sum, rep) => sum + rep.value, 0),
        ] as CellValue[];
      });
      tabRow = writeHouseTable(tab, tabRow, {
        columns: [
          { label: "District Manager", width: 34 },
          { label: "Region", width: 26 },
          { label: "Medical reps", numFmt: UNITS_FMT, right: true, width: 14 },
          { label: "Bricks", numFmt: UNITS_FMT, right: true, width: 12 },
          { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
        ],
        rows,
        title: `${line.line.lineName} · District Managers`,
        totals: [`${line.line.lineName} total`, null, null, null, rows.reduce((sum, row) => sum + Number(row[4] ?? 0), 0)],
        note: `${COVER_NOTE} Medical reps counts named reps; a vacant seat's bricks still count in the value.`,
      });
    }
  }

  if (repCount > 1) {
    const { tab, first } = levelTab(MEDICAL_REPS_TAB);
    let tabRow = first;
    for (const district of districts) {
      tabRow = writeHouseTable(tab, tabRow, {
        columns: [
          { label: "Medical rep", width: 34 },
          { label: "Line", width: 16 },
          { label: "Area", width: 30 },
          { label: "Bricks", numFmt: UNITS_FMT, right: true, width: 12 },
          { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
        ],
        rows: district.reps.map((rep) => [rep.name, rep.lineName, rep.areas.join(", "), rep.bricks, rep.value]),
        // The name alone, never "District Manager" after it: a Regional Manager can hold an area
        // directly (Hany Saad, Pedia Sharkia, from October 2026) and is never called a District Manager.
        title: `${district.name} · medical reps`,
        totals: [`${district.name} total`, null, null, null, district.value],
        note: COVER_NOTE,
      });
    }
  }

  const regionsByLine = groupBricksByRegion(model);
  const { tab: brickTab, first: brickFirst } = levelTab(BRICKS_TAB);
  let brickRow = brickFirst;
  if (regionsByLine.length === 0) {
    brickTab.getCell(brickRow, 1).value = "No product in this file sold on a brick in its closed months.";
  }
  for (const line of regionsByLine) {
    brickRow = writeHouseTable(brickTab, brickRow, {
      columns: [
        { label: "Region", width: 30 },
        { label: "Areas", numFmt: UNITS_FMT, right: true, width: 12 },
        { label: "Bricks", numFmt: UNITS_FMT, right: true, width: 12 },
        { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
      ],
      rows: line.regions.map((region) => [region.name, region.areas.length, region.bricks, region.value]),
      title: `${line.lineName} · by region`,
      totals: [`${line.lineName} total`, null, null, line.value],
      note: COVER_NOTE,
    });
    for (const region of line.regions) {
      brickRow = writeHouseTable(brickTab, brickRow, {
        columns: [
          { label: "Area", width: 30 },
          { label: "Medical rep", width: 30 },
          { label: "District Manager", width: 30 },
          { label: "Bricks", numFmt: UNITS_FMT, right: true, width: 12 },
          { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
        ],
        rows: region.areas.map((area) => [area.name, area.reps.join(", "), area.districtManagers.join(", "), area.bricks, area.value]),
        title: `${line.lineName} · ${region.name} · by area`,
        totals: [`${region.name} total`, null, null, null, region.value],
      });
      for (const area of region.areas) {
        brickRow = writeHouseTable(brickTab, brickRow, {
          columns: [
            { label: "Brick", width: 30 },
            { label: "Medical rep", width: 30 },
            { label: "Product", width: 30 },
            { label: "Forecast units", numFmt: UNITS_FMT, right: true, width: 12 },
            { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
          ],
          rows: area.rows.map((row) => [row.brick, row.rep, row.product, row.units, row.value]),
          title: `${region.name} · ${area.name} · ${INTEGER.format(area.bricks)} ${area.bricks === 1 ? "brick" : "bricks"}`,
          totals: [`${area.name} total`, null, null, null, area.value],
          note: "Each brick's share comes from its own sales of that product. A product's bricks add up to its forecast.",
        });
      }
    }
  }

  const scenarios = workbook.addWorksheet("Scenarios", { properties: { defaultRowHeight: 18 } });
  scenarios.views = [{ showGridLines: false }];
  let scenarioRow = writeHouseTable(scenarios, 1, {
    columns: [
      { label: "Scenario", width: 30 },
      { label: "Forecast value", numFmt: MONEY_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
      { label: `Short of ${model.goalPct}% goal`, numFmt: MONEY_FMT, right: true, width: 16 },
      { label: "Above the realistic level", numFmt: MONEY_FMT, right: true, width: 18 },
      { label: "What it means", width: 70 },
    ],
    rows: model.scenarios.map((scenario) => [
      `Scenario ${scenario.number} · ${scenario.title}`,
      scenario.value,
      scenario.achievement,
      scenario.shortOfGoal,
      scenario.aboveRealisticValue,
      scenarioSummary(scenario, model.goalPct, money),
    ]),
    title: `Three scenarios for a ${model.goalPct}% goal · whole plan`,
  });

  const byScenario = (index: number, code: string) => model.scenarios[index]?.units[code] ?? 0;
  const unitRows: CellValue[][] = model.lines.flatMap((line) =>
    line.line.remainingMonths > 0
      ? line.rows.map(({ row: product }) => [
          product.name,
          line.line.lineName,
          byScenario(0, product.productCode),
          byScenario(1, product.productCode),
          byScenario(2, product.productCode),
          model.scenarios[2]?.aboveRealistic[product.productCode] ?? 0,
        ])
      : [],
  );
  scenarioRow = writeHouseTable(scenarios, scenarioRow, {
    columns: [
      { label: "Product", width: 30 },
      { label: "Line", width: 16 },
      { label: "Scenario 1 units", numFmt: UNITS_FMT, right: true, width: 16 },
      { label: "Scenario 2 units", numFmt: UNITS_FMT, right: true, width: 16 },
      { label: "Scenario 3 units", numFmt: UNITS_FMT, right: true, width: 16 },
      { label: "Scenario 3 above realistic", numFmt: UNITS_FMT, right: true, width: 20 },
    ],
    rows: unitRows,
    title: model.filterNote ? "Units per product · filtered products only" : "Units per product",
    note: "Each product is planned in its own units. Units are never added across products.",
  });
  void scenarioRow;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** The bricks holding units, under the product's name — "By brick: Tanta 1 40 · Kafr 2 30". */
function brickText(bricks: ForecastExportModel["bricks"][string] | undefined): string {
  const held = (bricks ?? []).filter((brick) => brick.units > 0);
  if (held.length === 0) return "";
  return `<br><span class="muted">By brick: ${held
    .map((brick) => `${escapeHtml(brick.name)} ${INTEGER.format(brick.units)}`)
    .join(" · ")}</span>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The document's stylesheet, on the house identity. Square edges everywhere; ink, not fills — the
 * table is carried by hairlines and the 6% zebra; wrapping, never an ellipsis.
 */
const FORECAST_CSS = `
  ${HOUSE_IDENTITY_CSS}
  @page { size: A4 landscape; margin: 10mm 8mm 12mm; }
  * { box-sizing: border-box; border-radius: 0 !important; }
  body { margin: 0; color: var(--phx-doc-body); font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 8.2pt; line-height: 1.35; }
  .rpt__title { margin: 3mm 0 .8mm; color: var(--phx-doc-deep); font-size: 15pt; font-weight: 700; }
  .rpt__sub { margin: 0 0 3mm; color: var(--phx-doc-muted); font-size: 8.4pt; font-weight: 600; }
  .kpi { display: flex; flex-wrap: wrap; margin: 0 0 3mm; border-top: .5pt solid var(--phx-doc-hair); border-bottom: .5pt solid var(--phx-doc-hair); }
  .kpi__cell { flex: 1 1 0; min-width: 34mm; padding: 1.8mm 2.6mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
  .kpi__cell:first-child { border-inline-start: 0; }
  .kpi__k { display: block; color: var(--phx-doc-muted); font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .kpi__v { display: block; color: var(--phx-doc-deep); font-size: 11pt; font-weight: 700; }
  .filter { margin: 0 0 3mm; padding: 1.6mm 2.6mm; border-inline-start: 1mm solid #B3312C; color: #B3312C; font-weight: 700; }
  h2 { margin: 5mm 0 1.6mm; padding-bottom: 1mm; border-bottom: .6mm solid var(--phx-doc-blue); color: var(--phx-doc-deep); font-size: 10.5pt; font-weight: 700; break-after: avoid; }
  h2 span { color: var(--phx-doc-muted); font-size: 8pt; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: 1.2mm 1.6mm; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
  thead th { color: var(--phx-doc-deep); font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; border-top: .5pt solid var(--phx-doc-blue); border-bottom: .5pt solid var(--phx-doc-blue); }
  tbody tr:nth-child(even) { background: var(--phx-doc-tint); }
  tfoot td { border-top: .5pt solid var(--phx-doc-blue); border-bottom: 1.4pt double var(--phx-doc-blue); color: var(--phx-doc-deep); font-weight: 700; }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
  .muted { color: var(--phx-doc-muted); font-size: 7pt; }
  .good { color: #1E7B45; } .warn { color: #B4771A; } .bad { color: #B3312C; }
  thead { display: table-header-group; }
  /* Headings repeat on every page; the total must print ONCE, at the end — Chrome repeats a tfoot otherwise. */
  tfoot { display: table-row-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .notes { margin: 4mm 0 0; padding: 0; list-style: none; color: var(--phx-doc-muted); font-size: 7pt; }
  .notes li { margin: .6mm 0; padding-inline-start: 2.6mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
  .empty { margin: 6mm 0; padding: 3mm; border: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); text-align: center; }
`;

function tone(value: number | null): string {
  if (value == null) return "";
  return value >= 1 ? "good" : value >= 0.8 ? "warn" : "bad";
}

export function buildForecastPdfHtml(model: ForecastExportModel): string {
  const mark = satoLogoDataUri();
  const kpis: Array<[string, string]> = [
    ["Target", model.totals.targetValue == null ? "No target" : money(model.totals.targetValue)],
    ["Sold so far", money(model.totals.gradedValue)],
    ["Your forecast", money(model.totals.forecastValue)],
    ["Achievement", pct(model.totals.achievement)],
    ["Gap to target", gapText(model.totals.gapValue)],
    ["Goal", `${model.goalPct}%`],
    ...model.halves.map((half): [string, string] => [half.key === "sato" ? "Sato half" : "Total half", pct(half.achievement)]),
  ];

  const scenarioTable = `<h2>Three scenarios <span>for a ${model.goalPct}% goal · whole plan</span></h2>
  <table>
    <colgroup><col style="width:22%"><col style="width:13%"><col style="width:10%"><col style="width:13%"><col style="width:42%"></colgroup>
    <thead><tr><th>Scenario</th><th class="num">Forecast value</th><th class="num">Achievement</th><th class="num">Short of goal</th><th>What it means</th></tr></thead>
    <tbody>${model.scenarios
      .map(
        (scenario) => `<tr>
        <td><strong>Scenario ${scenario.number}</strong><br>${escapeHtml(scenario.title)}</td>
        <td class="num">${escapeHtml(money(scenario.value))}</td>
        <td class="num ${tone(scenario.achievement)}">${escapeHtml(pct(scenario.achievement))}</td>
        <td class="num">${scenario.shortOfGoal == null ? "—" : escapeHtml(scenario.shortOfGoal > 0 ? money(scenario.shortOfGoal) : "None")}</td>
        <td>${escapeHtml(scenarioSummary(scenario, model.goalPct, money))}</td>
      </tr>`,
      )
      .join("")}</tbody>
  </table>`;

  const lineTables =
    model.lines.length === 0
      ? `<p class="empty">No product matches these filters.</p>`
      : model.lines
          .map((line) => {
            const subtitle = [
              line.line.remainingMonths > 0 ? `forecasting ${line.line.forecastMonthLabels.join(", ")}` : "nothing open to forecast",
              line.line.untargetedMonthLabels.length > 0 ? `${line.line.untargetedMonthLabels.join(", ")} not forecast, no target yet` : null,
              line.rows.length < line.totalRows ? `${line.rows.length} of ${line.totalRows} products` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return `<h2>${escapeHtml(line.line.lineName)} <span>${escapeHtml(subtitle)}</span></h2>
  <table>
    <colgroup><col style="width:25%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:13%"><col style="width:12%"><col style="width:14%"></colgroup>
    <thead><tr><th>Product</th><th class="num">Target</th><th class="num">Sold so far</th><th class="num">Forecast units</th><th class="num">Forecast value</th><th class="num">Achievement</th><th class="num">Gap to target</th></tr></thead>
    <tbody>${line.rows
      .map(
        ({ row, figures }) => `<tr>
        <td><strong>${escapeHtml(row.name)}</strong><br><span class="muted">${escapeHtml([row.family, trendLabel(row.trend)].filter(Boolean).join(" · "))}</span>${brickText(model.bricks[row.productCode])}</td>
        <td class="num">${row.targetValue == null ? "—" : escapeHtml(money(row.targetValue))}<br><span class="muted">${row.targetUnits == null ? "No target" : `${INTEGER.format(row.targetUnits)} units`}</span></td>
        <td class="num">${escapeHtml(money(row.gradedValue))}<br><span class="muted">${INTEGER.format(row.gradedUnits)} units</span></td>
        <td class="num">${INTEGER.format(figures.typedUnits)}</td>
        <td class="num">${escapeHtml(money(figures.value))}</td>
        <td class="num ${tone(figures.achievement)}">${escapeHtml(pct(figures.achievement))}</td>
        <td class="num">${escapeHtml(gapText(figures.gapValue))}${figures.gapUnits != null && figures.gapUnits > 0 ? `<br><span class="muted">${INTEGER.format(figures.gapUnits)} units</span>` : ""}</td>
      </tr>`,
      )
      .join("")}</tbody>
    <tfoot><tr>
      <td>${escapeHtml(line.line.lineName)} total</td>
      <td class="num">${line.line.targetValue == null ? "—" : escapeHtml(money(line.line.targetValue))}</td>
      <td class="num">${escapeHtml(money(line.line.gradedValue))}</td>
      <td class="num muted">By value</td>
      <td class="num">${escapeHtml(money(line.forecastValue))}</td>
      <td class="num ${tone(line.achievement)}">${escapeHtml(pct(line.achievement))}</td>
      <td class="num">${escapeHtml(gapText(line.gapValue))}</td>
    </tr></tfoot>
  </table>`;
          })
          .join("");

  const realistic = model.scenarios.find((scenario) => scenario.key === "realistic");
  const notes = [
    "Sold so far counts closed months only. Achievement is sales so far plus forecast, over target value.",
    "Units are never added across different products; every total is value.",
    model.filterNote ? "A line's total row covers the whole line, including products the filter leaves out." : null,
    ...model.halves.map((half) => `${half.label}: ${halfText(half, model.goalPct)}.`),
    model.halves.length > 0 ? HALVES_NOTE : null,
    realistic?.reachesGoal === false ? `${HONESTY_SENTENCE}.` : null,
  ].filter((note): note is string => Boolean(note));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`Make It Happen forecast — ${model.periodLabel}`)}</title>
<style>${FORECAST_CSS}</style></head>
<body>
<header class="lh">
  <div class="lh__mark">${mark ? `<img src="${mark}" alt="">` : ""}</div>
  <div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Make It Happen forecast</span></div>
</header>
<div class="lh__rule"></div>
<h1 class="rpt__title">Make It Happen forecast</h1>
<p class="rpt__sub">${escapeHtml(`${model.periodLabel} · ${model.scopeLabel} · generated ${model.generatedAtLabel} (Cairo)`)}</p>
<div class="kpi">${kpis.map(([k, v]) => `<div class="kpi__cell"><span class="kpi__k">${escapeHtml(k)}</span><span class="kpi__v">${escapeHtml(v)}</span></div>`).join("")}</div>
${model.filterNote ? `<p class="filter">${escapeHtml(model.filterNote)}</p>` : ""}
${scenarioTable}
<ul class="notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
${lineTables}
</body></html>`;
}

/** Chromium needs a non-empty element for both templates, or it prints its own title and date. */
export function forecastPdfFooter(model: ForecastExportModel): string {
  return `<div style="width:100%;padding:0 8mm;font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:6.6pt;color:${HOUSE_COLORS.muted};display:flex;justify-content:space-between;">
    <span>${escapeHtml(`Make It Happen · ${model.periodLabel} · ${model.scopeLabel}`)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}
