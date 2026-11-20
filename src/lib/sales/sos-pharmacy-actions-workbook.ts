import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import type { PharmacyActionItem, PharmacyActionsResult } from "@/lib/sales/sos-pharmacy-actions";
import { filterPharmacyItems, listFilterWords, type PharmacyListFilter } from "@/lib/sales/sos-pharmacy-actions-filter";

// ─────────────────────────────────────────────────────────────────────────────
// THE PHARMACY ACTIONS SHEET — the download behind "Where my sales come from".
//
// Owner, 2026-11-20: "I want to extract the people who did not buy in October and bought in
// September … so I can send each rep to his own village." The screen already computes the lists
// (sos-pharmacy-actions.ts); this file only lays them out, one sheet per list, with each pharmacy's
// month-by-month history so a manager can filter for exactly the pattern he wants.
//
// 🔴 It is the SAME result the screen reads, built uncapped — never a second rule. Each month's units
// stand beside its EGP, one row per pharmacy and product; units are never added across products. Geography by NAME, never by code. El Qema never reaches it:
// the loader never passes revealSource, and Main Stores rows are not pharmacies.
// ─────────────────────────────────────────────────────────────────────────────

export type AreaPeople = { repName: string | null; managerName: string | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodLabel(period: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return "—";
  return `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/** A change as a percentage cut toward zero (the portal's words rule): −29.96% reads −29.9, never −30. */
export function truncatedPercent(change: number | null): number | null {
  if (change == null || !Number.isFinite(change)) return null;
  return Math.trunc(change * 1000) / 10;
}

/** The seat model's line key, the same folding closing-performance-review.ts uses. */
export function seatLineKey(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type PharmacyActionSheetKey = "stopped" | "dropping" | "newPharmacies";

/**
 * Every pharmacy of one list, ONE ROW PER PHARMACY AND PRODUCT, grouped by area name (the order inside
 * an area is the list's own). Each month stands as two plain numbers side by side — its units, then its
 * EGP — so a person can sort and filter on any one of them (owner, 2026-11-20: "beside every value
 * column, add units … separate everything to be able to filter").
 *
 * 🔴 A row is ONE product, so a unit count is never a sum of two products (or two strengths of one);
 * the sheet's total row adds EGP only — every units column is kept out of it.
 */
export function pharmacyActionSheetRows(input: {
  items: readonly PharmacyActionItem[];
  /** Newest first, as the result carries them. */
  periods: readonly string[];
  peopleByArea: ReadonlyMap<string, AreaPeople>;
  /**
   * The distributor's display name for a code — never the code. One pharmacy is one distributor's
   * customer code, so a pharmacy that moved distributor or was renumbered (EPDA in October 2026,
   * Ibn Sina's Lacto channel) shows as stopped under one and new under the other; the name lets the
   * reader see that.
   */
  distributorNameOf?: (code: string) => string;
}): ExportRow[] {
  const ordered = [...input.items].sort((left, right) => left.areaName.localeCompare(right.areaName));
  const rows: ExportRow[] = [];
  for (const item of ordered) {
    const people = input.peopleByArea.get(item.areaCode.toUpperCase());
    const base: ExportRow = {
      area: item.areaName,
      rep: people?.repName ?? "Vacant",
      manager: people?.managerName ?? "",
      brick: item.brickName,
      pharmacy: item.name,
      address: item.address,
      channel: item.isDirect ? "Direct order" : "Distributor",
      distributor: input.distributorNameOf ? input.distributorNameOf(item.key.split("|")[0] ?? "") : "",
    };
    const products = item.productHistory ?? [];
    if (products.length === 0) {
      // No product detail loaded: one row, the pharmacy's EGP per month, units left blank (never 0).
      const valueOf = new Map((item.history ?? []).map((entry) => [entry.period, entry.value]));
      const row: ExportRow = { ...base, product: "" };
      for (const period of input.periods) {
        row[`u_${period}`] = null;
        row[`v_${period}`] = valueOf.get(period) ?? 0;
      }
      row.lastBought = periodLabel(item.lastBoughtPeriod);
      rows.push(row);
      continue;
    }
    for (const product of products) {
      const byPeriod = new Map(product.months.map((month) => [month.period, month]));
      const row: ExportRow = { ...base, product: product.productName };
      for (const period of input.periods) {
        row[`u_${period}`] = byPeriod.get(period)?.units ?? 0;
        row[`v_${period}`] = byPeriod.get(period)?.value ?? 0;
      }
      const lastBought = [...product.months]
        .sort((left, right) => right.period.localeCompare(left.period))
        .find((month) => Math.abs(month.units) > 0.0001 || Math.abs(month.value) > 0.0001);
      row.lastBought = periodLabel(lastBought?.period);
      rows.push(row);
    }
  }
  return rows;
}

/** The three list sheets' columns. Exported for the test that pins units beside EGP and out of the total. */
export function pharmacyListColumns(periods: readonly string[]): ExportColumn[] {
  // Oldest month on the left, the month the list is read as of on the right — the way a person reads a
  // trend — and each month's units directly beside its EGP.
  const months = [...periods].reverse().flatMap<ExportColumn>((period) => [
    { key: `u_${period}`, label: `${periodLabel(period)} units`, numeric: true, excludeFromTotal: true, width: 12 },
    { key: `v_${period}`, label: `${periodLabel(period)} (EGP)`, numeric: true, width: 15 },
  ]);
  return [
    { key: "area", label: "Area", width: 22 },
    { key: "rep", label: "Medical rep", width: 24 },
    { key: "manager", label: "District manager", width: 24 },
    { key: "brick", label: "Brick", width: 24 },
    { key: "pharmacy", label: "Pharmacy", width: 34 },
    { key: "address", label: "Address", width: 40 },
    { key: "channel", label: "Bought through", width: 14 },
    { key: "distributor", label: "Distributor", width: 18 },
    { key: "product", label: "Product", width: 26 },
    ...months,
    { key: "lastBought", label: "Last bought", width: 13 },
  ];
}

export function pharmacyActionsFileName(line: string | null, latestPeriod: string | null): string {
  const slug = String(line ?? "sales").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sales";
  return `${slug}-pharmacies-stopped-dropping-new-${latestPeriod ?? "latest"}.xlsx`;
}

export async function buildPharmacyActionsWorkbook(input: {
  line: string | null;
  actions: PharmacyActionsResult;
  peopleByArea: ReadonlyMap<string, AreaPeople>;
  /** The screen's area pick and advanced filters; nothing set = every pharmacy in scope. */
  filter?: PharmacyListFilter;
  distributorNameOf?: (code: string) => string;
}): Promise<ExcelJS.Buffer> {
  const { actions, line } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const periods = [actions.latestPeriod, ...actions.priorPeriods].filter((period): period is string => Boolean(period));
  const earlier = actions.priorPeriods.length;
  const filter = input.filter ?? {};
  const pickedArea = filter.areaCode ? filter.areaCode.toUpperCase() : null;
  const inArea = (items: PharmacyActionItem[]) => filterPharmacyItems(items, filter);
  const areaName = pickedArea ? actions.areas.find((area) => area.code.toUpperCase() === pickedArea)?.name ?? pickedArea : null;

  const earlierWords = earlier === 0
    ? "no earlier closing"
    : earlier === 1
      ? periodLabel(actions.priorPeriods[0])
      : `${periodLabel(actions.priorPeriods[actions.priorPeriods.length - 1])} to ${periodLabel(actions.priorPeriods[0])}`;
  const filterWords = listFilterWords(filter);
  const scopeWords = `${line ?? "Sales"}${areaName ? ` · ${areaName}` : ""}${filterWords ? ` · ${filterWords}` : ""} · read as of the ${periodLabel(actions.latestPeriod)} closing, compared with ${earlierWords}`;

  const lists: { key: PharmacyActionSheetKey; sheet: string; title: string; rule: string }[] = [
    {
      key: "stopped",
      sheet: "Stopped buying",
      title: "Stopped buying",
      rule: `Bought in ${earlier === 1 ? "" : "at least one of "}${earlierWords}, and nothing in ${periodLabel(actions.latestPeriod)}`,
    },
    {
      key: "dropping",
      sheet: "Dropping 30%+",
      title: "Dropping 30% or more",
      rule: `${periodLabel(actions.latestPeriod)} is 30% or more below its average over ${earlierWords}`,
    },
    {
      key: "newPharmacies",
      sheet: "New buyers",
      title: "New buyers",
      rule: `Bought in ${periodLabel(actions.latestPeriod)} and ${earlier === 1 ? "not in" : "in none of"} ${earlierWords}`,
    },
  ];

  // Summary first: one row per area, so a manager sees where to send whom before opening a list.
  const areaCodes = new Set<string>();
  for (const list of lists) for (const item of inArea(actions[list.key])) areaCodes.add(item.areaCode.toUpperCase());
  const summaryRows: ExportRow[] = [...areaCodes]
    .map((code) => {
      const mine = (key: PharmacyActionSheetKey) => inArea(actions[key]).filter((item) => item.areaCode.toUpperCase() === code);
      const stopped = mine("stopped");
      const dropping = mine("dropping");
      const fresh = mine("newPharmacies");
      const people = input.peopleByArea.get(code);
      const sum = (items: PharmacyActionItem[], pick: (item: PharmacyActionItem) => number) =>
        Math.round(items.reduce((total, item) => total + pick(item), 0) * 100) / 100;
      return {
        area: stopped[0]?.areaName ?? dropping[0]?.areaName ?? fresh[0]?.areaName ?? code,
        rep: people?.repName ?? "Vacant",
        manager: people?.managerName ?? "",
        stopped: stopped.length,
        stoppedValue: sum(stopped, (item) => item.priorAverage),
        dropping: dropping.length,
        droppingValue: sum(dropping, (item) => item.priorAverage - item.latestValue),
        fresh: fresh.length,
        freshValue: sum(fresh, (item) => item.latestValue),
      };
    })
    .sort((left, right) => String(left.area).localeCompare(String(right.area)));

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Pharmacies to visit — by area",
    subtitle: scopeWords,
    sheetName: "By area",
    columns: [
      { key: "area", label: "Area", width: 24 },
      { key: "rep", label: "Medical rep", width: 26 },
      { key: "manager", label: "District manager", width: 26 },
      { key: "stopped", label: "Stopped buying", numeric: true, width: 12 },
      { key: "stoppedValue", label: "Their monthly average before (EGP)", numeric: true, width: 20 },
      { key: "dropping", label: "Dropping 30%+", numeric: true, width: 12 },
      { key: "droppingValue", label: "Below their average (EGP)", numeric: true, width: 18 },
      { key: "fresh", label: "New buyers", numeric: true, width: 12 },
      { key: "freshValue", label: "In their first month (EGP)", numeric: true, width: 18 },
    ],
    rows: summaryRows,
  });

  const columns = pharmacyListColumns(periods);
  for (const list of lists) {
    addPhoenixTableSheet(workbook, {
      theme: "house",
      title: list.title,
      subtitle: `${scopeWords} · ${list.rule} · one row per pharmacy and product · units are per product and never added across products`,
      sheetName: list.sheet,
      columns,
      rows: pharmacyActionSheetRows({
        items: inArea(actions[list.key]),
        periods,
        peopleByArea: input.peopleByArea,
        distributorNameOf: input.distributorNameOf,
      }),
    });
  }

  return workbook.xlsx.writeBuffer();
}
