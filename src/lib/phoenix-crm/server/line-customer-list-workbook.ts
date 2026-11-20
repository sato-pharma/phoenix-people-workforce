/**
 * Phoenix CRM — a whole line's customer list, as one workbook, grouped by region and then by rep
 * (owner's ask, 2026-11-18: "export xlsx sheet for the full line, example Pedia line, customer list
 * grouped per rep per region").
 *
 * It lives under `server/` because it imports ExcelJS, which `phoenix-crm-boundary` keeps out of the
 * modules bundled for the phone. It is a pure builder: the service (`line-customer-list.ts`) reads the
 * territories and hands them here already shaped, so a test can build the file from a literal.
 *
 * ## House identity
 *
 * A workbook naming every customer of a line leaves the building, so it wears `SATO-DIS-2026-01` like
 * the list template beside it — `buildHouseCoverSheet` and `writeHouseTable`, never the Phoenix kit.
 *
 * ## What is on it
 *
 *   Cover           — the line, who prepared it, and how many territories and customers it holds.
 *   Summary         — one table per region: each rep's territory with its AM · PM · Pharmacies counts,
 *                     apart (the AM · PM · PHARMACIES GOLDEN RULE), and the region's total.
 *   <Region> sheets — one per region; inside it one table per rep, every customer on that rep's list.
 *   All customers   — the same rows flat, with the region and the rep on every row and a filter on
 *                     the header, for sorting and pivoting in Excel.
 *
 * "On the list" is the rep's list proper: validated, or waiting to be validated at the door. The
 * Archive and the customers met outside the list are not on it and are not exported.
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";

export type LineListCustomer = {
  /** "PM", "AM" or "Pharmacy". */
  listType: string;
  name: string;
  speciality: string | null;
  grade: string | null;
  potential: string | null;
  /** "On the list" (validated) or "Waiting to be validated". */
  status: string;
  primaryPharmacy: string | null;
  daysAndHours: string | null;
  phone: string | null;
};

export type LineListTerritory = {
  seatId: string;
  /** `territoryName(seat)` — the area and the line. */
  territoryName: string;
  areaName: string | null;
  regionName: string | null;
  /** Null when the seat is vacant: its carried-over list still belongs to the seat. */
  repName: string | null;
  districtManagerName: string | null;
  customers: readonly LineListCustomer[];
};

export type LineListInput = {
  lineName: string;
  preparedFor: string;
  generatedAtIso: string;
  territories: readonly LineListTerritory[];
};

type LineListRegion = { regionName: string; territories: LineListTerritory[] };

export const NO_REGION = "No region";
export const VACANT_SEAT = "Seat vacant";

const LIST_ORDER: Record<string, number> = { AM: 1, PM: 0, Pharmacy: 2 };

function listRank(listType: string): number {
  return LIST_ORDER[listType] ?? 3;
}

/**
 * The regions in name order ("No region" last), and inside each region the reps in name order — a
 * vacant seat after the filled ones, then by territory — and inside each rep the customers PM, AM,
 * Pharmacy, then by name. One ordering, used by every sheet, so the Summary and the region sheets read
 * in the same order.
 */
function groupLineTerritories(territories: readonly LineListTerritory[]): LineListRegion[] {
  const byRegion = new Map<string, LineListTerritory[]>();
  for (const territory of territories) {
    const regionName = territory.regionName?.trim() || NO_REGION;
    const sorted: LineListTerritory = {
      ...territory,
      customers: [...territory.customers].sort(
        (left, right) => listRank(left.listType) - listRank(right.listType) || left.name.localeCompare(right.name),
      ),
    };
    const list = byRegion.get(regionName) ?? [];
    list.push(sorted);
    byRegion.set(regionName, list);
  }
  return [...byRegion.entries()]
    .sort(([left], [right]) => (left === NO_REGION ? 1 : right === NO_REGION ? -1 : left.localeCompare(right)))
    .map(([regionName, list]) => ({
      regionName,
      territories: list.sort(
        (left, right) =>
          Number(left.repName === null) - Number(right.repName === null)
          || (left.repName ?? "").localeCompare(right.repName ?? "")
          || left.territoryName.localeCompare(right.territoryName),
      ),
    }));
}

type ListCounts = { pm: number; am: number; pharmacy: number; validated: number; waiting: number; total: number };

/** AM · PM · Pharmacies, counted apart — a pharmacy is never inside PM or AM. */
function countCustomers(customers: readonly LineListCustomer[]): ListCounts {
  const counts: ListCounts = { am: 0, pharmacy: 0, pm: 0, total: 0, validated: 0, waiting: 0 };
  for (const customer of customers) {
    if (customer.listType === "PM") counts.pm += 1;
    else if (customer.listType === "AM") counts.am += 1;
    else if (customer.listType === "Pharmacy") counts.pharmacy += 1;
    if (customer.status === "On the list") counts.validated += 1;
    else counts.waiting += 1;
    counts.total += 1;
  }
  return counts;
}

/** Excel refuses `[]:*?/\` in a sheet name and anything past 31 characters; two regions never share one. */
function regionSheetName(regionName: string, taken: Set<string>): string {
  const base = regionName.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Region";
  let name = base;
  for (let index = 2; taken.has(name.toLowerCase()); index += 1) {
    const suffix = ` (${index})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function column(label: string, width: number, right = false): TableColumn {
  return right ? { label, right: true, width } : { label, width };
}

const SUMMARY_COLUMNS: TableColumn[] = [
  column("Rep", 30),
  column("Territory", 30),
  column("District manager", 26),
  column("PM", 9, true),
  column("AM", 9, true),
  column("Pharmacies", 12, true),
  column("Validated", 11, true),
  column("Waiting to be validated", 14, true),
  column("Total", 10, true),
];

const CUSTOMER_COLUMNS: TableColumn[] = [
  column("List", 10),
  column("Customer name", 34),
  column("Speciality", 20),
  column("Grade", 8),
  column("Potential", 10),
  column("Status", 22),
  column("Primary pharmacy", 26),
  column("Days and hours", 34),
  column("Phone", 16),
];

function customerCells(customer: LineListCustomer): CellValue[] {
  return [
    customer.listType,
    customer.name,
    customer.speciality ?? "",
    customer.grade ?? "",
    customer.potential ?? "",
    customer.status,
    customer.primaryPharmacy ?? "",
    customer.daysAndHours ?? "",
    customer.phone ?? "",
  ];
}

function countCells(counts: ListCounts): CellValue[] {
  return [counts.pm, counts.am, counts.pharmacy, counts.validated, counts.waiting, counts.total];
}

function sumCounts(all: readonly ListCounts[]): ListCounts {
  return all.reduce<ListCounts>(
    (sum, counts) => ({
      am: sum.am + counts.am,
      pharmacy: sum.pharmacy + counts.pharmacy,
      pm: sum.pm + counts.pm,
      total: sum.total + counts.total,
      validated: sum.validated + counts.validated,
      waiting: sum.waiting + counts.waiting,
    }),
    { am: 0, pharmacy: 0, pm: 0, total: 0, validated: 0, waiting: 0 },
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function territoryWord(count: number): string {
  return `${count} ${count === 1 ? "territory" : "territories"}`;
}

export async function buildLineCustomerListWorkbook(input: LineListInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const regions = groupLineTerritories(input.territories);
  const lineTotals = sumCounts(input.territories.map((territory) => countCustomers(territory.customers)));
  const generated = new Date(input.generatedAtIso).toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });

  buildHouseCoverSheet(workbook, {
    confidentialNote:
      "This workbook names every customer on the line's lists, with the grades set for them. It is for the SFE Manager "
      + "and the Super Admin, and goes to nobody else.",
    rows: [
      ["Line", input.lineName],
      ["Regions", String(regions.length)],
      ["Territories", String(input.territories.length)],
      ["Customers on the lists", `${lineTotals.total} — ${lineTotals.pm} PM · ${lineTotals.am} AM · ${lineTotals.pharmacy} pharmacies`],
      ["Validated", `${lineTotals.validated} validated · ${lineTotals.waiting} waiting to be validated`],
      ["What is included", "Each rep's list: customers validated at the door, and those waiting to be. The Archive is not included."],
      ["Prepared for", input.preparedFor],
      ["Generated", `${generated} (Cairo)`],
    ],
    subtitle: `${input.lineName} line · customer list by region and rep`,
    title: "Line customer list",
  });

  // Summary — a table per region, each rep a row, the region's total under it.
  const summary = workbook.addWorksheet("Summary", { properties: { defaultRowHeight: 18 } });
  summary.views = [{ showGridLines: false }];
  let summaryRow = 1;
  for (const region of regions) {
    const rows = region.territories.map((territory) => [
      territory.repName ?? VACANT_SEAT,
      territory.territoryName,
      territory.districtManagerName ?? "Vacant",
      ...countCells(countCustomers(territory.customers)),
    ]);
    const totals = sumCounts(region.territories.map((territory) => countCustomers(territory.customers)));
    summaryRow = writeHouseTable(summary, summaryRow, {
      columns: SUMMARY_COLUMNS,
      rows,
      title: `${region.regionName} · ${territoryWord(region.territories.length)}`,
      totals: [`${region.regionName} total`, "", "", ...countCells(totals)],
    });
    summaryRow += 1;
  }
  writeHouseTable(summary, summaryRow, {
    columns: SUMMARY_COLUMNS,
    rows: [[`${input.lineName} line`, `${territoryWord(input.territories.length)}`, `${plural(regions.length, "region")}`, ...countCells(lineTotals)]],
    title: `${input.lineName} line total`,
  });

  // One sheet per region, one table per rep.
  const taken = new Set<string>(["cover", "summary", "all customers"]);
  for (const region of regions) {
    const sheet = workbook.addWorksheet(regionSheetName(region.regionName, taken), { properties: { defaultRowHeight: 18 } });
    sheet.views = [{ showGridLines: false }];
    let row = 1;
    for (const territory of region.territories) {
      const counts = countCustomers(territory.customers);
      const who = territory.repName ?? VACANT_SEAT;
      row = writeHouseTable(sheet, row, {
        columns: CUSTOMER_COLUMNS,
        note: territory.customers.length === 0 ? "No customer is on this territory's list." : undefined,
        rows: territory.customers.map(customerCells),
        title: `${who} · ${territory.territoryName} · ${counts.pm} PM · ${counts.am} AM · ${counts.pharmacy} pharmacies`,
      });
      row += 1;
    }
  }

  // Every row flat, the region and the rep on each, with a filter — for Excel's own sort and pivot.
  const flat = workbook.addWorksheet("All customers", { properties: { defaultRowHeight: 18 } });
  const flatColumns: TableColumn[] = [column("Region", 18), column("Rep", 28), column("Territory", 28), column("District manager", 24), ...CUSTOMER_COLUMNS];
  const flatRows: CellValue[][] = [];
  for (const region of regions) {
    for (const territory of region.territories) {
      for (const customer of territory.customers) {
        flatRows.push([
          region.regionName,
          territory.repName ?? VACANT_SEAT,
          territory.territoryName,
          territory.districtManagerName ?? "Vacant",
          ...customerCells(customer),
        ]);
      }
    }
  }
  writeHouseTable(flat, 1, { columns: flatColumns, rows: flatRows, title: `${input.lineName} line · every customer` });
  flat.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  if (flatRows.length > 0) {
    flat.autoFilter = { from: { column: 1, row: 2 }, to: { column: flatColumns.length, row: 2 + flatRows.length } };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
