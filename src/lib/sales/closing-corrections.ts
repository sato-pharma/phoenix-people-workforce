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
};

export type NetNegativeCell = {
  line: string;
  distributorName: string;
  areaCode: string;
  areaName: string;
  productName: string;
  units: number;
  value: number;
  impact: string;
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
};

export type ClosingCorrectionsResult = {
  period: string | null;
  prevPeriod: string | null;
  availablePeriods: string[];
  reversalPairs: ReversalPair[];
  netNegatives: NetNegativeCell[];
  lateReturns: LateReturn[];
  /** True when the month has nothing in any section — the page shows one calm all-clear. */
  isEmpty: boolean;
};

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
): Pick<ClosingCorrectionsResult, "reversalPairs" | "netNegatives" | "lateReturns" | "isEmpty"> {
  const reversalPairs: ReversalPair[] = [];
  const netNegatives: NetNegativeCell[] = [];
  const lateReturns: LateReturn[] = [];

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
      });
    } else if (row.kind === "net_negative") {
      netNegatives.push({
        line: row.line,
        distributorName: row.distributorName,
        areaCode: row.areaCode,
        areaName: row.areaName,
        productName: row.productName,
        units: row.units,
        value: row.value,
        impact: `Returns exceed sales here by ${units(row.units)} (${egp(row.value)}) this month.`,
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
