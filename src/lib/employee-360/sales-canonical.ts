// ─────────────────────────────────────────────────────────────────────────────
// Employee 360's sales rows, sourced from SoS Monthly Closing instead of sales_records.
//
// Employee 360 was the last surface still answering "how much did this person sell" from the
// legacy table. It disagreed with every other screen: for rep B-158 it rendered 700,019.87
// (140% of target) while the incentive tab, the monthly dashboard, the closing view and
// reconciliation all read 460,228.50 for the same six months — a 52% overstatement, and every
// single month differed (May was 4.1x). Rule #1 says a person's month reads identically
// everywhere, so this module produces the SAME SalesRow shape deep-service already aggregates,
// from the canonical engine.
//
// Sibling of employee-portal/portal-sales-canonical.ts and sales/dashboard-canonical.ts, and
// deliberately built the same way — one range load, merge areas, gate on the upload ledger,
// resolve codes to names. Divergence between these three is exactly the class of bug this
// whole migration exists to remove.
//
// Three things here are load-bearing:
//
//   1. A MONTH WITH NO DISTRIBUTOR UPLOAD IS DROPPED, not zeroed. August 2026 holds one direct
//      order (1,309.50 EGP) against a 17,508,935 EGP target — B-158's own share of that target
//      is 200,875.95. Emitted as a data point it puts a 0% month on the trend and, summed into
//      the total, takes him from 136.6% to 66.2% — below the incentive scheme's 90% floor,
//      which pays zero. `has_actual` cannot tell a landed month from a stray direct order; the
//      distributor batch ledger can, and it is what /sales-vs-target already trusts.
//
//   2. ROWS ARE PRE-AGGREGATED per (rep, period, product). The engine emits one row per
//      (rep, area, product); a rep working two areas therefore emits two rows for the same
//      product in the same month. deep-service's aggregateSalesRows sums, so that is harmless
//      there — but summing here first keeps the row count honest for `hasData` and for the
//      "no validated sales" message.
//
//   3. CONFIDENTIAL PRODUCTS ARE STRIPPED BY CODE. sales_records had no product code, so the
//      old path matched LA003/LA004/SS001 by NAME and inherited every typo and rename in the
//      product column. Canonical rows carry the code, so the exact strip is available and is
//      what this module uses.
// ─────────────────────────────────────────────────────────────────────────────

import { cache } from "react";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import {
  RESTRICTED_PRODUCT_CODES,
  canViewRestrictedProducts,
  stripRestrictedRows,
} from "@/lib/sales/access-scope";
import {
  lineName,
  loadProductFamilyMap,
  loadProductNameMap,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import {
  SALES_HISTORY_FLOOR,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
} from "@/lib/sales/vs-target";

import type { SalesRow } from "./deep-service";

/**
 * deep-service's SalesRow plus the two identifiers the canonical engine has and the legacy
 * table never did.
 *
 * `productCode` is load-bearing: it is what makes the exact restricted-product strip possible.
 * `managerHrId` is carried because it is part of the row's identity in the seat model, but it
 * is NOT used for scoping — see selectEmployee360RowsForHrIds for why that is deliberate.
 */
export type CanonicalEmployee360SalesRow = SalesRow & {
  productCode: string;
  managerHrId: string | null;
};

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

type Aggregate = {
  repHrId: string;
  dmHrId: string | null;
  lineCode: string | null;
  productCode: string;
  period: string;
  salesValue: number;
  targetValue: number;
};

/**
 * Fold canonical rows into one aggregate per (rep, period, product). PURE.
 *
 * Rows for a month whose distributor upload has not landed are dropped (see note 1 above), and
 * rows the engine could not attribute to an occupant belong to the AREA rather than to a
 * person — crediting them to whoever is nearby is precisely the error that makes one screen
 * disagree with another.
 */
export function aggregateCanonicalEmployee360Rows(
  rows: readonly AchievementRow[],
  uploadedPeriods: ReadonlySet<string>,
): Aggregate[] {
  const byKey = new Map<string, Aggregate>();
  for (const row of rows) {
    if (!uploadedPeriods.has(row.period)) continue;
    const repHrId = lower(row.repHrId);
    if (!repHrId) continue;

    const productCode = upper(row.productCode);
    const key = `${repHrId}|${row.period}|${productCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.salesValue += row.actualValue;
      existing.targetValue += row.targetValue ?? 0;
      continue;
    }
    byKey.set(key, {
      repHrId,
      dmHrId: lower(row.dmHrId) || null,
      lineCode: row.lineCode,
      productCode,
      period: row.period,
      salesValue: row.actualValue,
      targetValue: row.targetValue ?? 0,
    });
  }
  return [...byKey.values()];
}

/** Aggregates -> the row shape deep-service aggregates. PURE. */
export function toEmployee360SalesRows(
  aggregates: readonly Aggregate[],
  productNames: ReadonlyMap<string, string>,
  productFamilies: ReadonlyMap<string, string>,
): CanonicalEmployee360SalesRow[] {
  return aggregates.map((aggregate) => {
    const [yearPart, monthPart] = aggregate.period.split("-");
    return {
      employee_hr_id: upper(aggregate.repHrId),
      managerHrId: aggregate.dmHrId ? upper(aggregate.dmHrId) : null,
      line: aggregate.lineCode ? lineName(aggregate.lineCode) : null,
      family: productFamilies.get(aggregate.productCode) ?? null,
      // Falls back to the CODE, never to a placeholder: an unmapped SKU stays visible and
      // countable in the product list instead of collapsing into one "—" bucket with every
      // other unmapped product, which is how a real seller disappears from Top Products.
      product: productNames.get(aggregate.productCode) ?? aggregate.productCode,
      productCode: aggregate.productCode,
      month: Number(monthPart) || null,
      year: Number(yearPart) || null,
      sales_value: aggregate.salesValue,
      target_value: aggregate.targetValue,
    };
  });
}

/**
 * Every canonical Employee-360 sales row in the reportable window, for every rep. UNFILTERED.
 *
 * Four round trips regardless of team size — the achievement range, the upload ledger and the
 * two display-name maps. The legacy path this replaces PAGED sales_records 1,000 rows at a time
 * per chunk of 100 HR-id keys, so an NSM's line cost dozens of sequential Atlantic round trips;
 * the engine answers the whole window in one.
 *
 * Memoized per request, like portal-sales-canonical's equivalent: the rows are company-wide and
 * viewer-independent, so there is nothing scope-sensitive to leak — the narrowing to a person
 * and the confidential-product mask both happen after, per viewer.
 */
export const loadCanonicalEmployee360SalesRows = cache(
  async (): Promise<CanonicalEmployee360SalesRow[]> => {
    const { year, month } = currentCairoDateParts();
    const to = `${year}-${String(month).padStart(2, "0")}`;

    const [rows, uploadedPeriods, productNames, productFamilies] = await Promise.all([
      loadAchievementRange(SALES_HISTORY_FLOOR, to),
      loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, to),
      loadProductNameMap(),
      loadProductFamilyMap(),
    ]);

    // Merge Fayoum/Beni Suef BEFORE aggregating: the merge rewrites areaCode without summing, so
    // aggregating first would leave one rep split across two codes on the lines that merge.
    const merged = applyAchievementAreaMerges(rows);
    return toEmployee360SalesRows(
      aggregateCanonicalEmployee360Rows(merged, uploadedPeriods),
      productNames,
      productFamilies,
    );
  },
);

/**
 * Keep the rows belonging to these people. PURE.
 *
 * Matches on the REP only — deliberately, even though every row also carries its DM.
 *
 * The caller passes the subject plus their whole org subtree, so a manager's reports are
 * already in `hrIds` and the DM leg would add nothing when the subtree and the seat model
 * agree. When they DISAGREE it would silently widen a manager's total to include reps the
 * caller did not ask about — a scope change wearing the clothes of an engine change. The
 * legacy query this replaces matched `employee_hr_id` alone; that scoping is preserved here
 * exactly, so the only thing that moves in this migration is which engine answers.
 */
export function selectEmployee360RowsForHrIds(
  rows: readonly CanonicalEmployee360SalesRow[],
  hrIds: readonly string[],
): CanonicalEmployee360SalesRow[] {
  const wanted = new Set(hrIds.map(lower).filter(Boolean));
  if (wanted.size === 0) return [];
  return rows.filter((row) => wanted.has(lower(row.employee_hr_id)));
}

/**
 * Keep the rows belonging to these product families. PURE.
 *
 * The PM path: a Product Manager has no reports, so their sales are the sales of the brands
 * they own. Matched case-insensitively on the family name, as the legacy `.in("family", …)`
 * effectively was against a curated column.
 */
export function selectEmployee360RowsForFamilies(
  rows: readonly CanonicalEmployee360SalesRow[],
  families: readonly string[],
): CanonicalEmployee360SalesRow[] {
  const wanted = new Set(families.map(lower).filter(Boolean));
  if (wanted.size === 0) return [];
  return rows.filter((row) => wanted.has(lower(row.family)));
}

/**
 * Strip confidential products for a viewer who may not see them.
 *
 * By CODE, which the legacy path could not do. LA003/LA004/SS001 are the whole of the Head
 * Office line; they must never reach a total, KPI, chart or product list for a viewer below
 * CEO/Super Admin. A viewer who may see them gets the rows untouched.
 */
export function maskRestrictedEmployee360Rows(
  rows: readonly CanonicalEmployee360SalesRow[],
  viewerRole: PhoenixRole,
): CanonicalEmployee360SalesRow[] {
  if (canViewRestrictedProducts(viewerRole)) return [...rows];
  return stripRestrictedRows([...rows], RESTRICTED_PRODUCT_CODES);
}
