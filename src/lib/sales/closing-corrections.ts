// Closing Corrections — the read layer over phx_closing_corrections.
//
// The owner's ask (2026-08-05): "a detailed page with situations like this" — where "this" was
// the Haram–Faisal (GZ4) posting that Ibn Sina-Sato added in June and subtracted in July, and the
// Beni Suef (UE9) customer who bought 120 units in March and returned them in June. Situations
// where the data is booked exactly as the distributor sent it, every total is arithmetically
// right, and one month still READS wrong.
//
// Three kinds, detected in SQL (see the migration for the thresholds and the reasoning):
//   reversal_pair — plus-then-minus across two consecutive months, same distributor+area+product.
//   net_negative  — a month cell where returns exceed sales.
//   late_return   — a client-level return traced to its most recent purchase month with the SAME
//                   distributor (client codes are only unique per distributor).
//
// This module maps the RPC rows to named view models and writes the one-sentence explanation per
// row, so the page never shows a bare number the reader has to decode. Detection thresholds live
// in the SQL only; nothing here filters further — the page shows exactly what the RPC found.

import { listMonthlyClosingPeriods } from "@/lib/sales/monthly-distributor-import";
import { previousPeriod } from "@/lib/sales/source-coverage";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export type ClosingCorrectionRow = {
  kind: "reversal_pair" | "net_negative" | "late_return";
  period: string;
  otherPeriod: string | null;
  line: string;
  distributorCode: string;
  distributorName: string;
  areaCode: string;
  areaName: string;
  productCode: string;
  productName: string;
  clientName: string | null;
  units: number;
  value: number;
  otherUnits: number | null;
  otherValue: number | null;
};

/**
 * The other sections a row's own (line, area, product) cell ALSO appears in.
 *
 * One return commonly trips more than one detector — that is the detectors working, not a fault —
 * but the page said nothing about it, so the same money was printed two or three times at two or
 * three different magnitudes with no reconciliation. Measured on production for 2026-07: the page
 * listed 17 rows over 12 distinct cells, and D21/RO001 and D21/SA001 each appeared in ALL THREE
 * sections. A reader summing the sentences for D21/SA001 got roughly 62,000 EGP of July distortion
 * from one return whose actual effect on the closing's cell is -12,559.95.
 */
export type AlsoSeenIn = readonly string[];

export type ReversalPair = {
  line: string;
  distributorName: string;
  areaCode: string;
  areaName: string;
  productName: string;
  positivePeriod: string;
  positiveUnits: number;
  positiveValue: number;
  negativePeriod: string;
  negativeUnits: number;
  negativeValue: number;
  impact: string;
  /** Other sections listing this same cell. Empty when this row stands alone. */
  alsoSeenIn: AlsoSeenIn;
};

/**
 * One AREA x PRODUCT cell of the closing that nets below zero — every distributor together, which
 * is how phx_monthly_closing_matrix groups it, and therefore what "the closing shows a negative
 * there" actually means.
 *
 * THERE IS DELIBERATELY NO `distributorName` HERE. It used to carry one, because the RPC grouped by
 * distributor as well, so every row was one distributor's share of the cell presented as the cell.
 * Measured on production 2026-09-05 across 2026-05..07: 7 of the 10 rows disagreed with the
 * closing, three of them in SIGN — AB4/RO001 read -34 units on a cell that is +31, and D21/SA001
 * read -179 on a cell that is -13. A cell built from several distributors has no single
 * distributor, and naming one is what made this page contradict the closing it exists to explain.
 */
export type NetNegativeCell = {
  line: string;
  areaCode: string;
  areaName: string;
  productName: string;
  units: number;
  value: number;
  impact: string;
  /** Other sections listing this same cell. Empty when this row stands alone. */
  alsoSeenIn: AlsoSeenIn;
};

export type LateReturn = {
  line: string;
  distributorName: string;
  areaCode: string;
  areaName: string;
  productName: string;
  clientName: string;
  units: number;
  value: number;
  originPeriod: string | null;
  originUnits: number | null;
  impact: string;
  /** Other sections listing this same cell. Empty when this row stands alone. */
  alsoSeenIn: AlsoSeenIn;
};

export type ClosingCorrectionsResult = {
  period: string | null;
  prevPeriod: string | null;
  availablePeriods: string[];
  reversalPairs: ReversalPair[];
  netNegatives: NetNegativeCell[];
  lateReturns: LateReturn[];
  /**
   * DISTINCT situations, not rows. One return routinely trips two or three detectors, and the
   * headline used to add the three section lengths together — so a month with 12 real situations
   * announced 17 (production, 2026-07). The page exists to size how far a month reads wrong before
   * sign-off, so an inflated headline inflates exactly the judgement it is there to inform.
   *
   * A situation is one (line, area, product) cell: the grain the closing itself is read at, and the
   * grain at which "this month reads wrong here" is a single fact.
   */
  situationCount: number;
  /** True when the month has nothing in any section — the page shows one calm all-clear. */
  isEmpty: boolean;
};

/** The three section headings, as the page prints them. Used for the cross-references. */
const SECTION_LABEL: Record<ClosingCorrectionRow["kind"], string> = {
  late_return: "Returns landing long after their sale",
  net_negative: "Returns bigger than the month's sales",
  reversal_pair: "Corrections that span two months",
};

/** One situation = one (line, area, product) cell — the grain the closing is read at. */
function situationKey(row: { areaCode: string; line: string; productCode?: string; productName: string }): string {
  return [row.line, row.areaCode, row.productCode ?? row.productName].join("|").toLowerCase();
}

function egp(value: number): string {
  return `${Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })} EGP`;
}

function units(value: number): string {
  return `${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 1 })} units`;
}

/**
 * Pure grouping + sentence writing over already-named rows. Exported for tests: the sentences are
 * the product here — a wrong sentence misleads exactly the reader this page exists to protect.
 */
export function groupClosingCorrections(
  rows: readonly ClosingCorrectionRow[],
  period: string,
): Pick<ClosingCorrectionsResult, "reversalPairs" | "netNegatives" | "lateReturns" | "situationCount" | "isEmpty"> {
  const reversalPairs: ReversalPair[] = [];
  const netNegatives: NetNegativeCell[] = [];
  const lateReturns: LateReturn[] = [];

  // Which detectors each cell tripped. Built BEFORE the rows are mapped, so every row can be told
  // where else its own cell appears — one return showing up three times is the detectors working,
  // but the reader has to be told it is one return and not three.
  const kindsByCell = new Map<string, Set<ClosingCorrectionRow["kind"]>>();
  for (const row of rows) {
    const key = situationKey(row);
    const kinds = kindsByCell.get(key) ?? new Set<ClosingCorrectionRow["kind"]>();
    kinds.add(row.kind);
    kindsByCell.set(key, kinds);
  }
  const alsoSeenInFor = (row: ClosingCorrectionRow): string[] =>
    [...(kindsByCell.get(situationKey(row)) ?? [])]
      .filter((kind) => kind !== row.kind)
      .map((kind) => SECTION_LABEL[kind])
      .sort();

  for (const row of rows) {
    if (row.kind === "reversal_pair") {
      // The RPC anchors the pair on the POSITIVE month; other* is the negative month.
      const negativePeriod = row.otherPeriod ?? period;
      reversalPairs.push({
        line: row.line,
        distributorName: row.distributorName,
        areaCode: row.areaCode,
        areaName: row.areaName,
        productName: row.productName,
        positivePeriod: row.period,
        positiveUnits: row.units,
        positiveValue: row.value,
        negativePeriod,
        negativeUnits: row.otherUnits ?? 0,
        negativeValue: row.otherValue ?? 0,
        impact:
          `${row.distributorName} posted +${units(row.units)} (${egp(row.value)}) in ${row.period}, ` +
          `then took ${units(row.otherUnits ?? 0)} back in ${negativePeriod} — ` +
          `${row.period} reads high and ${negativePeriod} reads low by roughly that much.`,
        alsoSeenIn: alsoSeenInFor(row),
      });
    } else if (row.kind === "net_negative") {
      // No distributor: the RPC sends distributorCode NULL for this kind because the row IS the
      // closing's cell, summed across every distributor. See NetNegativeCell.
      netNegatives.push({
        line: row.line,
        areaCode: row.areaCode,
        areaName: row.areaName,
        productName: row.productName,
        units: row.units,
        value: row.value,
        impact:
          `Across every distributor, returns exceed sales in this cell by ${units(row.units)} ` +
          `(${egp(row.value)}) this month.`,
        alsoSeenIn: alsoSeenInFor(row),
      });
    } else {
      const originPeriod = row.otherPeriod;
      lateReturns.push({
        line: row.line,
        distributorName: row.distributorName,
        areaCode: row.areaCode,
        areaName: row.areaName,
        productName: row.productName,
        clientName: row.clientName ?? "(no client name)",
        units: row.units,
        value: row.value,
        originPeriod,
        originUnits: row.otherUnits,
        impact: originPeriod
          ? `Returned ${units(row.units)} (${egp(row.value)}); last bought from ${row.distributorName} ` +
            `in ${originPeriod} (${units(row.otherUnits ?? 0)}) — the return lands months after its sale.`
          : `Returned ${units(row.units)} (${egp(row.value)}) with no earlier purchase on file from ` +
            `${row.distributorName} — worth checking the file with the distributor.`,
        alsoSeenIn: alsoSeenInFor(row),
      });
    }
  }

  // Biggest distortion first in every section — the reader's first row is always the worst one.
  reversalPairs.sort((left, right) => Math.abs(right.negativeValue) - Math.abs(left.negativeValue));
  netNegatives.sort((left, right) => left.value - right.value);
  lateReturns.sort((left, right) => left.value - right.value);

  return {
    reversalPairs,
    netNegatives,
    lateReturns,
    // DISTINCT cells, never the sum of the three section lengths. Adding them counted one return
    // as up to three situations: production 2026-07 has 17 rows over 12 cells, and two of those
    // cells appear in ALL THREE sections.
    situationCount: kindsByCell.size,
    isEmpty: reversalPairs.length === 0 && netNegatives.length === 0 && lateReturns.length === 0,
  };
}

/**
 * Load one month's corrections. Same default-month behaviour as the closing itself: the latest
 * validated period when none is requested. Names are resolved here (standing rule: names, never
 * raw codes) — areas from the areas master, distributors from the latest batch that carried them.
 */
export async function loadClosingCorrections(input?: {
  period?: string | null;
}): Promise<ClosingCorrectionsResult> {
  const availablePeriods = await listMonthlyClosingPeriods();
  const requested = String(input?.period ?? "").trim();
  const period = requested && availablePeriods.includes(requested)
    ? requested
    : availablePeriods[0] ?? null;

  if (!period) {
    return {
      period: null,
      prevPeriod: null,
      availablePeriods,
      reversalPairs: [],
      netNegatives: [],
      lateReturns: [],
      situationCount: 0,
      isEmpty: true,
    };
  }

  const supabase = getSupabaseAdmin();
  const [raw, areasResult, batchesResult] = await Promise.all([
    rpcAll(supabase, "phx_closing_corrections", { p_period: period }, [
      "kind", "distributor_code", "area_code", "product_code",
    ]),
    supabase.from("source_of_sales_areas").select("area_code,area_name"),
    supabase.from("source_of_sales_import_batches").select("distributor_code,distributor_name"),
  ]);
  if (areasResult.error) throw areasResult.error;
  if (batchesResult.error) throw batchesResult.error;

  const areaNameByCode = new Map<string, string>();
  for (const row of areasResult.data ?? []) {
    const typed = row as { area_code?: unknown; area_name?: unknown };
    const code = String(typed.area_code ?? "").trim().toUpperCase();
    const name = String(typed.area_name ?? "").trim();
    if (code && name) areaNameByCode.set(code, name);
  }
  const distributorNameByCode = new Map<string, string>();
  for (const row of batchesResult.data ?? []) {
    const typed = row as { distributor_code?: unknown; distributor_name?: unknown };
    const code = String(typed.distributor_code ?? "").trim();
    const name = String(typed.distributor_name ?? "").trim();
    if (code && name && !distributorNameByCode.has(code)) distributorNameByCode.set(code, name);
  }

  const rows: ClosingCorrectionRow[] = (raw as Record<string, unknown>[]).map((row) => {
    const distributorCode = String(row.distributor_code ?? "");
    const areaCode = String(row.area_code ?? "").trim().toUpperCase();
    return {
      kind: String(row.kind ?? "") as ClosingCorrectionRow["kind"],
      period: String(row.period ?? ""),
      otherPeriod: row.other_period == null ? null : String(row.other_period),
      line: String(row.line ?? ""),
      distributorCode,
      distributorName: distributorNameByCode.get(distributorCode) ?? distributorCode,
      areaCode,
      areaName: areaNameByCode.get(areaCode) ?? (areaCode || "(no area)"),
      productCode: String(row.product_code ?? ""),
      productName: String(row.product_name ?? "") || String(row.product_code ?? ""),
      clientName: row.client_name == null ? null : String(row.client_name),
      units: Number(row.units ?? 0),
      value: Number(row.value ?? 0),
      otherUnits: row.other_units == null ? null : Number(row.other_units),
      otherValue: row.other_value == null ? null : Number(row.other_value),
    };
  });

  return {
    period,
    prevPeriod: previousPeriod(period),
    availablePeriods,
    ...groupClosingCorrections(rows, period),
  };
}
