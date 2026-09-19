// Weekly Sales — Branch Detail XLSX (the code says depot; every label the reader sees says branch,
// owner 2026-09-19). Ships BESIDE the password-locked weekly designs
// (export-design.pins.json) and wears the HOUSE identity (SATO-DIS-2026-01 v1.0) on every tab, like the
// Weekly Stock workbook it mirrors tab for tab.
//
// It exports exactly what the screen shows for the same query: the rows come from the same loader the
// feed calls, so the viewer's scope travels with them, and a Medical Rep's book holds his own screen and
// nothing wider (no region tab, no other area). A manager's book carries the "How It Reached You" columns
// only when his own areas' share of a depot-split depot is in it — the same test his screen's labels answer.
//
// THE TOTAL ROW. addPhoenixTableSheet appends a TOTAL row that SUMs every `numeric` column. So a column
// is numeric here only when its sum means something: value, average weekly value, share, and counts of
// product-depot rows. Units, average weekly units and week counts are never summed (units of different
// products are never added — owner rule), so they are plain columns right-aligned after the sheet is
// built. There is no hand-written total row on top of it: that would count the money twice.

import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import {
  WEEKLY_SALES_DETAIL_BASIS_LABELS,
  WEEKLY_SALES_DETAIL_MOVEMENT_LABELS,
  weeklySalesDetailShowsBasis,
  weeklySalesMovement,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailAudience,
  type WeeklySalesDetailGroupRow,
} from "@/lib/sales/weekly/sales-depot-detail";

type SheetColumn = ExportColumn & {
  /** a number that must not be summed: right-aligned after the sheet is built */
  plainNumber?: boolean;
  /** a 0–1 share, shown as a percentage */
  percent?: boolean;
};

const FIRST_DATA_ROW = 4;

function addSheet(
  workbook: ExcelJS.Workbook,
  input: { title: string; subtitle: string; sheetName: string; columns: SheetColumn[]; rows: ExportRow[] },
) {
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: input.title,
    subtitle: input.subtitle,
    sheetName: input.sheetName,
    columns: input.columns.map((column) => ({
      key: column.key,
      label: column.label,
      numeric: column.numeric,
      width: column.width,
    })),
    rows: input.rows,
  });
  const sheet = workbook.getWorksheet(input.sheetName);
  if (!sheet) return;
  // The TOTAL row exists whenever a column is numeric and there is at least one row.
  const hasTotal = input.rows.length > 0 && input.columns.some((column) => column.numeric);
  const lastRow = FIRST_DATA_ROW + input.rows.length - 1 + (hasTotal ? 1 : 0);
  input.columns.forEach((column, index) => {
    if (!column.plainNumber && !column.percent) return;
    const col = index + 1;
    if (column.plainNumber) {
      // The house header has a ground, so addPhoenixTableSheet centres its labels vertically.
      sheet.getRow(3).getCell(col).alignment = { vertical: "middle", horizontal: "right", wrapText: true };
    }
    for (let row = FIRST_DATA_ROW; row <= lastRow; row += 1) {
      const cell = sheet.getRow(row).getCell(col);
      if (column.plainNumber) cell.alignment = { vertical: "middle", horizontal: "right", wrapText: false };
      if (column.percent) cell.numFmt = "0.0%";
    }
  });
}

const share = (value: number | null) => (value == null ? "" : Number(value.toFixed(4)));
const orDash = (value: number | null) => (value == null ? "—" : value);

const groupMovement = (group: WeeklySalesDetailGroupRow) =>
  WEEKLY_SALES_DETAIL_MOVEMENT_LABELS[weeklySalesMovement(0, group.value)];

function groupRows(rows: WeeklySalesDetailGroupRow[], withParent: boolean): ExportRow[] {
  return rows.map((group) => ({
    ...(withParent ? { parent: group.parentName } : {}),
    name: group.name,
    value: group.value,
    avgWeeklyValue: group.avgWeeklyValue,
    share: share(group.share),
    movement: groupMovement(group),
    productCount: group.productCount,
    soldCount: group.soldCount,
    returnsCount: group.returnsCount,
    returnsValue: group.returnsValue,
  }));
}

const groupColumns = (nameLabel: string, parentLabel: string | null): SheetColumn[] => [
  ...(parentLabel ? [{ key: "parent", label: parentLabel, width: 24 }] : []),
  { key: "name", label: nameLabel, width: 30 },
  { key: "value", label: "Sales Value (EGP)", numeric: true, width: 18 },
  { key: "avgWeeklyValue", label: "Avg Weekly Value (EGP)", numeric: true, width: 20 },
  { key: "share", label: "Share of Value", numeric: true, percent: true, width: 12 },
  { key: "movement", label: "Movement", width: 12 },
  { key: "productCount", label: "Products", plainNumber: true, width: 10 },
  { key: "soldCount", label: "Sold Rows", numeric: true, width: 10 },
  { key: "returnsCount", label: "Returns Rows", numeric: true, width: 12 },
  { key: "returnsValue", label: "Returns Value (EGP)", numeric: true, width: 18 },
];

export function buildWeeklySalesDepotDetailWorkbook(
  payload: WeeklySalesDepotDetailPayload,
  context: { generatedAtCairo: string },
): ExcelJS.Workbook {
  const { view, scope } = payload;
  const isRep = view.audience === "rep";
  // A rep's book always says how each figure reached him; a manager's only when a depot-split share is in it.
  const showBasis = weeklySalesDetailShowsBasis(view);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  const subtitle = `${scope.summary} · ${scope.periodLabel}`;

  // ── Tab 1: every product at every depot — the grain people read.
  const cellRows: ExportRow[] = view.cells.map((cell) => ({
    ...(isRep ? {} : { region: cell.regionName }),
    area: cell.areaName,
    distributor: cell.distributorName,
    depot: cell.branchName,
    line: cell.line,
    product: cell.productName,
    ...(showBasis ? { basis: WEEKLY_SALES_DETAIL_BASIS_LABELS[cell.basis], allocatedValue: cell.allocatedValue } : {}),
    units: cell.units,
    value: cell.value,
    avgWeeklyUnits: orDash(cell.avgWeeklyUnits),
    avgWeeklyValue: cell.avgWeeklyValue ?? "",
    weeksSold: cell.weeksSold,
    weeksCovered: cell.weeksCovered,
    share: share(cell.share),
    movement: WEEKLY_SALES_DETAIL_MOVEMENT_LABELS[cell.movement],
  }));
  addSheet(workbook, {
    title: isRep ? "My Weekly Sales by Branch and Product" : "Weekly Sales by Branch and Product",
    subtitle,
    sheetName: "Sales by Branch",
    columns: [
      ...(isRep ? [] : [{ key: "region", label: "Region", width: 16 }]),
      { key: "area", label: "Area", width: 20 },
      { key: "distributor", label: "Distributor", width: 18 },
      { key: "depot", label: "Branch", width: 26 },
      { key: "line", label: "Line", width: 14 },
      { key: "product", label: "Product", width: 26 },
      ...(showBasis ? [{ key: "basis", label: "How It Reached You", width: 18 }] : []),
      { key: "units", label: "Net Units", plainNumber: true, width: 11 },
      { key: "value", label: "Sales Value (EGP)", numeric: true, width: 16 },
      ...(showBasis ? [{ key: "allocatedValue", label: "Of Which Allocated (EGP)", numeric: true, width: 18 }] : []),
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", plainNumber: true, width: 13 },
      { key: "avgWeeklyValue", label: "Avg Weekly Value (EGP)", numeric: true, width: 18 },
      { key: "weeksSold", label: "Weeks Sold", plainNumber: true, width: 10 },
      { key: "weeksCovered", label: "Weeks Covered", plainNumber: true, width: 11 },
      { key: "share", label: "Share of Value", numeric: true, percent: true, width: 12 },
      { key: "movement", label: "Movement", width: 12 },
    ],
    rows: cellRows,
  });

  // ── Tab 2: one product code (one concentration) across depots — the only valid unit total.
  addSheet(workbook, {
    title: isRep ? "My Weekly Sales by Product" : "Weekly Sales by Product",
    subtitle,
    sheetName: "By Product",
    columns: [
      { key: "line", label: "Line", width: 16 },
      { key: "product", label: "Product", width: 28 },
      { key: "units", label: "Net Units", plainNumber: true, width: 12 },
      { key: "value", label: "Sales Value (EGP)", numeric: true, width: 18 },
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", plainNumber: true, width: 14 },
      { key: "avgWeeklyValue", label: "Avg Weekly Value (EGP)", numeric: true, width: 20 },
      { key: "share", label: "Share of Value", numeric: true, percent: true, width: 12 },
      { key: "movement", label: "Movement", width: 12 },
      { key: "depotCount", label: "Branches", plainNumber: true, width: 10 },
      { key: "soldDepots", label: "Branches Sold", plainNumber: true, width: 11 },
      { key: "returnsDepots", label: "Branches Returns", plainNumber: true, width: 13 },
    ],
    rows: view.products.map((product) => ({
      line: product.line,
      product: product.productName,
      units: product.units,
      value: product.value,
      avgWeeklyUnits: product.avgWeeklyUnits,
      avgWeeklyValue: product.avgWeeklyValue,
      share: share(product.share),
      movement: WEEKLY_SALES_DETAIL_MOVEMENT_LABELS[weeklySalesMovement(product.units, product.value)],
      depotCount: product.depotCount,
      soldDepots: product.soldDepots,
      returnsDepots: product.returnsDepots,
    })),
  });

  addSheet(workbook, {
    title: isRep ? "My Weekly Sales by Branch (value)" : "Weekly Sales by Branch (value)",
    subtitle,
    sheetName: "By Branch",
    columns: groupColumns("Branch", isRep ? "Distributor" : "Region · Distributor"),
    rows: groupRows(view.depots, true),
  });
  // A rep's screen shows the Areas tab only when his view spans more than one area; the book follows it.
  if (!isRep || view.availableAreas.length > 1) {
    addSheet(workbook, {
      title: isRep ? "My Weekly Sales by Area (value)" : "Weekly Sales by Area (value)",
      subtitle,
      sheetName: "By Area",
      columns: groupColumns("Area", "Region"),
      rows: groupRows(view.areas, true),
    });
  }
  // A rep sees no region total, not even one that would only restate his own.
  if (!isRep) {
    addSheet(workbook, {
      title: "Weekly Sales by Region (value)",
      subtitle,
      sheetName: "By Region",
      columns: groupColumns("Region", null),
      rows: groupRows(view.regions, false),
    });
  }
  addSheet(workbook, {
    title: isRep ? "My Weekly Sales by Distributor (value)" : "Weekly Sales by Distributor (value)",
    subtitle,
    sheetName: "By Distributor",
    columns: groupColumns("Distributor", null),
    rows: groupRows(view.distributors, false),
  });

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "How to read this workbook",
    subtitle,
    sheetName: "Notes",
    columns: [
      { key: "topic", label: "Topic", width: 24 },
      { key: "rule", label: "Rule", width: 100 },
    ],
    rows: weeklySalesDepotDetailNotes(payload, context.generatedAtCairo),
  });

  return workbook;
}

/** The Notes tab. Exported so the test suite can hold the screen's footnote and the book to one story. */
export function weeklySalesDepotDetailNotes(
  payload: WeeklySalesDepotDetailPayload,
  generatedAtCairo: string,
): { topic: string; rule: string }[] {
  const isRep = payload.view.audience === "rep";
  const showBasis = weeklySalesDetailShowsBasis(payload.view);
  return [
    { topic: "Scope", rule: payload.scope.summary },
    { topic: "Period", rule: payload.scope.periodLabel },
    { topic: "Generated", rule: `${generatedAtCairo} (Cairo)` },
    {
      topic: "Sales",
      rule: "Net sales (sales less returns) from each distributor's weekly sheets. Most distributors restate the month to date, so each sheet is reduced by the sheet before it.",
    },
    {
      topic: "Value",
      rule: "Net units multiplied by the current Product Master factory price. Direct orders keep the value written on their own sheet.",
    },
    { topic: "Units", rule: "Units are shown per product and concentration only. Totals across different products are values, never units." },
    {
      topic: "Average per week",
      rule: "A figure divided by the weeks its distributor's uploads cover in the period. A sheet that follows a missed upload covers the missed week too, and a twice-monthly distributor's sheets cover two weeks each, so a missed upload never reads as a week with no sales.",
    },
    { topic: "Weeks sold", rule: "Of the weeks covered, the weeks in which the product sold at that branch." },
    { topic: "Movement", rule: "Sold when more went out than came back over the period; Net returns when more came back." },
    ...(isRep
      ? [
          {
            topic: "How it reached you",
            rule: "Mapped by hand: the branch is mapped to your area, so its whole sale is yours. Allocated share: the branch's name places it across several areas, and this is your area's even share of it. Part allocated: both, because the branch's mapping changed inside the period. An allocation spreads branch shipments; it is not a record of sales observed in your territory.",
          },
        ]
      : [
          ...(showBasis
            ? [
                {
                  topic: "How it reached you",
                  rule: "Whole branch: the branch is mapped to one of your areas by hand, or no rule places it in an area, so its whole sale is shown. Allocated share: the branch's name places it across several areas, and this is the part that falls in your own areas; the parts in other managers' areas are not counted. Part allocated: both, because the branch's mapping changed inside the period. An allocation spreads branch shipments; it is not a record of sales observed in your territory.",
                },
              ]
            : []),
          {
            topic: "Area not mapped",
            rule: showBasis
              ? "Branches no rule places in an area (warehouses, tenders) carry no area and are listed under this label, one line per region."
              : "Branches that serve several areas (key accounts, wholesale, warehouses) carry no single area and are listed under this label, one line per region.",
          },
        ]),
    ...(payload.allocationUnavailable
      ? [
          {
            topic: "Allocation missing",
            rule: isRep
              ? "The branch-to-area map did not load when this file was made, so only branches mapped to your area by hand are counted and the figures read low."
              : "The branch-to-area map did not load when this file was made, so branches serving several areas are not split: one filed under your own region counts whole, and one filed under another region is not counted.",
          },
        ]
      : []),
    {
      topic: "Unmapped products",
      rule: "Products the Product Master has not mapped to a line are left out of every figure here.",
    },
    { topic: "Lines", rule: "CNS, Anti Infective and Pedia only. Head Office products are not tracked in weekly figures." },
    { topic: "Official figure", rule: "Weekly sales are an early read. The Monthly Closing remains the official sales number." },
  ];
}

/** `phoenix-weekly-sales-branch-detail-2026-09.xlsx`; a rep's reads `phoenix-weekly-sales-my-branches-2026-09.xlsx`. */
export function buildWeeklySalesDepotDetailFilename(audience: WeeklySalesDetailAudience, months: readonly string[]): string {
  const tag = [...new Set(months.map((month) => /^(\d{4}-\d{2})/.exec(month.trim())?.[1]).filter(Boolean))].sort().join("_");
  const base = audience === "rep" ? "phoenix-weekly-sales-my-branches" : "phoenix-weekly-sales-branch-detail";
  return `${base}-${tag || "all-months"}.xlsx`;
}
