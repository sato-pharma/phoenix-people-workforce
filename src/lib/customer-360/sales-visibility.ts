/**
 * What a viewer is allowed to see of a customer's sales — and the trap in the column names.
 *
 * `source_of_sales_channel_customer_rollup` carries each customer's money twice:
 *
 *   value_all         the whole figure
 *   value_restricted  the CONFIDENTIAL part of that figure
 *
 * `value_restricted` reads like "the figure with restrictions applied", i.e. the safe one. It is the
 * exact opposite: it is the restricted money ITSELF. Measured on production 2026-09-03 across the
 * 364 pharmacies this module covers:
 *
 *   Head Office      value_all 4,118,893   value_restricted 4,118,893
 *   Pedia            value_all 1,446,005   value_restricted 0
 *   CNS              value_all   997,258   value_restricted 0
 *   Anti Infective   value_all   596,393   value_restricted 0
 *
 * So `value_restricted` is entirely Head Office, and Head Office is 58% of these customers' money.
 * Reading the name the natural way and showing `value_restricted` to a District Manager would show
 * him a number that is 100% confidential — the precise thing `canViewHeadOfficeLine` exists to stop.
 *
 * Two separate rules land on the same numbers, and both are honoured here:
 *
 *  - Head Office and the restricted products are CEO / Super Admin only, fail-closed
 *    (`src/lib/sales/access-scope.ts`).
 *  - The tracked lines are CNS, Anti Infective and Pedia ONLY. Head Office is deliberately absent
 *    from weekly and monthly reporting, and must be filtered before any number is quoted — it is
 *    not a mapping defect to be repaired.
 *
 * Head Office is therefore never inside a headline total for anyone. A CEO or Super Admin sees it,
 * but as its own separately labelled line, never folded into the customer's total.
 */

import type { PhoenixRole } from "@/lib/auth/permissions";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";

/** The line name the confidential money is reported under. */
export const HEAD_OFFICE_LINE = "Head Office";

export type CustomerSalesRollupRow = {
  readonly officialLine: string | null;
  readonly period: string | null;
  readonly unitsAll: number | null;
  readonly unitsRestricted: number | null;
  readonly valueAll: number | null;
  readonly valueRestricted: number | null;
};

export type CustomerSalesLineTotal = {
  readonly confidential: boolean;
  readonly line: string;
  readonly units: number;
  readonly value: number;
};

export type CustomerSalesView = {
  /** Head Office, present only when the viewer may see it. Never part of `trackedValue`. */
  readonly confidentialLines: CustomerSalesLineTotal[];
  /** True when Head Office money exists but this viewer is not allowed to see it. */
  readonly confidentialWithheld: boolean;
  readonly periods: string[];
  readonly trackedLines: CustomerSalesLineTotal[];
  readonly trackedUnits: number;
  /** The headline number. Tracked lines only — never includes Head Office, for any role. */
  readonly trackedValue: number;
};

function isHeadOffice(line: string | null): boolean {
  return (line ?? "").trim().toLowerCase() === HEAD_OFFICE_LINE.toLowerCase();
}

function toNumber(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fold a customer's rollup rows into what this viewer may see.
 *
 * Subtracting `value_restricted` from `value_all` on a tracked line is belt-and-braces: every
 * tracked line reads 0 restricted today, but a restricted PRODUCT inside a tracked line would show
 * up there, and the subtraction means such a product is withheld the day it appears rather than the
 * day someone notices. Fail-closed by construction, not by vigilance.
 */
export function buildCustomerSalesView(
  rows: readonly CustomerSalesRollupRow[],
  role: PhoenixRole,
): CustomerSalesView {
  const maySeeConfidential = canViewHeadOfficeLine(role);
  const tracked = new Map<string, { units: number; value: number }>();
  const confidential = new Map<string, { units: number; value: number }>();
  const periods = new Set<string>();
  let confidentialSeen = false;

  for (const row of rows) {
    const period = (row.period ?? "").trim();
    if (period) periods.add(period);

    const line = (row.officialLine ?? "").trim() || "(no line)";
    const restrictedValue = toNumber(row.valueRestricted);
    const restrictedUnits = toNumber(row.unitsRestricted);

    if (isHeadOffice(row.officialLine)) {
      if (toNumber(row.valueAll) !== 0 || toNumber(row.unitsAll) !== 0) confidentialSeen = true;
      if (!maySeeConfidential) continue;
      const bucket = confidential.get(line) ?? { units: 0, value: 0 };
      bucket.units += toNumber(row.unitsAll);
      bucket.value += toNumber(row.valueAll);
      confidential.set(line, bucket);
      continue;
    }

    if (restrictedValue !== 0 || restrictedUnits !== 0) confidentialSeen = true;
    const bucket = tracked.get(line) ?? { units: 0, value: 0 };
    // A privileged viewer sees the whole line; everyone else has the restricted part removed.
    bucket.units += maySeeConfidential ? toNumber(row.unitsAll) : toNumber(row.unitsAll) - restrictedUnits;
    bucket.value += maySeeConfidential ? toNumber(row.valueAll) : toNumber(row.valueAll) - restrictedValue;
    tracked.set(line, bucket);
  }

  const toTotals = (
    source: Map<string, { units: number; value: number }>,
    isConfidential: boolean,
  ): CustomerSalesLineTotal[] =>
    Array.from(source.entries())
      .map(([line, totals]) => ({
        confidential: isConfidential,
        line,
        units: totals.units,
        value: totals.value,
      }))
      .filter((entry) => entry.value !== 0 || entry.units !== 0)
      .sort((a, b) => b.value - a.value);

  const trackedLines = toTotals(tracked, false);

  return {
    confidentialLines: toTotals(confidential, true),
    confidentialWithheld: confidentialSeen && !maySeeConfidential,
    periods: Array.from(periods).sort(),
    trackedLines,
    trackedUnits: trackedLines.reduce((sum, entry) => sum + entry.units, 0),
    trackedValue: trackedLines.reduce((sum, entry) => sum + entry.value, 0),
  };
}
