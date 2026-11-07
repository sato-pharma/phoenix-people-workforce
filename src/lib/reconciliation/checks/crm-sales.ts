import { systemAccessContext } from "@/lib/auth/permissions";
import { formatCount, formatList, formatMoney, moneyMatches } from "@/lib/reconciliation/compare";
import { retryOnceIfBreached } from "@/lib/reconciliation/retry";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { getSosDashboard, type SosCustomerRow } from "@/lib/sales/sos-dashboard";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Check 9 — every CRM identity with recent fieldwork resolves to an employee — was retired with the
// vendor on 7 November 2026. Its left side, the Unmapped Agents punch-list, is derived from
// ireports360_visits, which nothing has written since iReports360 was retired on 6 November; and a
// Phoenix CRM visit is filed by an employee seat, so it always carries a resolved hr id. The check
// could only ever compare a frozen archive with itself. The numbers of the checks after it are left as
// they were, as check 10's were; the other files refer to them by number.

// Check 10 — the iReports360 visits-sync freshness check — was retired with the vendor on 6 November
// 2026: nothing pulls from it any more, so its run ledger is history, not a pipeline to watch. The
// numbers of the checks after it are left as they were; the other files refer to them by number.

/** A customer is one (client, distributor) pair — a client code alone is not unique across distributors. */
function customerKey(row: SosCustomerRow): string {
  return `${row.distributor}::${row.code}`;
}

/**
 * Check 11 — Source-of-Sales Top Customers lists each customer once, at its full selected-period
 * total.
 *
 * fetchGeo maps phx_exec_customers over every selected period and FLATTENS, and sos-dashboard.ts
 * never groups the result — while the sibling brick panel does group (brickAccum), so the two
 * panels disagree by construction. On a two-month view a customer appears once per month at one
 * month's value, understating its total and ranking it wrongly, and customerTop10Share
 * (concentration risk) is computed off the same ungrouped list.
 *
 * The right-hand side is the SAME service asked one month at a time, not a hand-written copy of
 * the RPC call. Re-typing the twelve scope/exclude arguments the service assembles would create a
 * second definition of "which rows this viewer may see", and a drift in that copy would show up as
 * a money mismatch that looks exactly like the defect — the check would then be lying in the same
 * way the screen is. Per-period grouping is the identity operation (the RPC emits one row per
 * customer per period, verified: 12,110 rows / 12,110 distinct keys for 2026-06), so the
 * single-month answers are the trustworthy ones to add up.
 */
const topCustomersListEachCustomerOnce: ReconciliationCheck = {
  id: "sos-top-customers-one-row-per-customer",
  title: "Source-of-Sales Top Customers lists each customer once, at its full selected-period total",
  domain: "crm-sales",
  severity: "high",
  expectation: "holds",
  // Was known-open until 2026-10-23: sos-dashboard.ts groups the customer list on (distributor, client) before it ranks.
  async run(): Promise<ReconciliationOutcome> {
    const options = { revealRestrictedProducts: true } as const;
    const base = await getSosDashboard({}, systemAccessContext, options);
    const periods = base.availablePeriods.slice(0, 2);
    if (periods.length < 2) {
      return {
        left: { source: "getSosDashboard({ periods }).topCustomers", value: "single-period view only" },
        right: { source: "the same service asked one period at a time", value: "single-period view only" },
        holds: true,
        detail: "Fewer than two validated periods exist, so no multi-month selection can be built yet.",
      };
    }

    const [multi, ...singles] = await Promise.all([
      getSosDashboard({ periods }, systemAccessContext, options),
      ...periods.map((period) => getSosDashboard({ period }, systemAccessContext, options)),
    ]);

    const problems: string[] = [];

    const seen = new Map<string, SosCustomerRow[]>();
    for (const row of multi.topCustomers) {
      const rows = seen.get(customerKey(row)) ?? [];
      rows.push(row);
      seen.set(customerKey(row), rows);
    }
    for (const [, rows] of seen) {
      if (rows.length > 1) {
        problems.push(
          `${rows[0].name} (${rows[0].distributor}) is listed ${rows.length} times — ${rows.map((row) => formatMoney(row.value)).join(" and ")} instead of once at ${formatMoney(rows.reduce((total, row) => total + row.value, 0))}`,
        );
      }
    }

    // Value check. Only customers present in EVERY selected month's own list can be summed with
    // certainty — one outside a month's top 15 is indistinguishable from one with no sales that
    // month, and guessing between them is what would turn this into a nagging false alarm.
    const perPeriod = singles.map((single) => new Map(single.topCustomers.map((row) => [customerKey(row), row])));
    let verified = 0;
    for (const [key, rows] of seen) {
      if (!perPeriod.every((index) => index.has(key))) continue;
      verified += 1;
      const expected = perPeriod.reduce((total, index) => total + (index.get(key)?.value ?? 0), 0);
      const shown = rows.reduce((total, row) => total + row.value, 0);
      if (!moneyMatches(shown, expected, 0.01 * periods.length)) {
        problems.push(
          `${rows[0].name} (${rows[0].distributor}): the ${periods.join(" + ")} view shows ${formatMoney(shown)} against ${formatMoney(expected)} across those months`,
        );
      }
    }

    return {
      left: {
        source: `getSosDashboard({ periods: ${JSON.stringify(periods)} }).topCustomers`,
        value: `${formatCount(multi.topCustomers.length, "row")} covering ${formatCount(seen.size, "customer")}`,
      },
      right: {
        source: `the same service asked for ${periods.join(" and ")} separately, added up per customer`,
        value: `${formatCount(verified, "customer")} independently verifiable`,
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `Every customer in the ${periods.join(" + ")} view appears once, at its full total across both months.`
          : formatList(problems),
    };
  },
};

/**
 * Check 12 — the coverage numerator is drawn from the coverage denominator's population.
 *
 * Targets the audited "coverage ratios exceeded 100% because numerator and denominator described
 * different populations", and its mirror image, which this file has already survived once:
 * totalBricks used to BE the numerator expression, so brick coverage was permanently 100% and the
 * KPI could never show a gap. Asserting both counts against independently-derived master sets
 * catches both directions — a ratio inside its bound because the populations agree, not because
 * something clamped it.
 *
 * `active = true` is not a guess: it is the predicate loadSalesReferenceData itself applies when
 * it builds the masters this dashboard divides by.
 */
const coverageNumeratorInsideMasterDenominator: ReconciliationCheck = {
  id: "sos-coverage-numerator-inside-master-denominator",
  title: "Areas/bricks reached come from the same population as the areas/bricks total",
  domain: "crm-sales",
  severity: "medium",
  expectation: "holds",
  // loadSalesReferenceData swallows a failed master read and hands the dashboard an EMPTY area
  // list, which would show up here as a denominator of 0 against the master's 49 — a transient
  // read failure wearing the costume of a coverage defect. A re-read separates the two.
  run: retryOnceIfBreached(async (): Promise<ReconciliationOutcome> => {
    const dashboard = await getSosDashboard({}, systemAccessContext, { revealRestrictedProducts: true });
    const supabase = getSupabaseAdmin();
    const [areaRows, brickRows] = await Promise.all([
      fetchAllRows<{ area_code: string | null }>(
        () => supabase.from("source_of_sales_areas").select("area_code").eq("active", true),
        "area_code",
      ),
      fetchAllRows<{ brick_id: string | null }>(
        () => supabase.from("source_of_sales_bricks").select("brick_id").eq("active", true),
        "brick_id",
      ),
    ]);

    const masterAreas = new Set(
      areaRows.map((row) => String(row.area_code ?? "").trim().toUpperCase()).filter(Boolean),
    );
    const masterBricks = new Set(
      brickRows.map((row) => String(row.brick_id ?? "").trim().toUpperCase()).filter(Boolean),
    );

    // byArea is the same leaf set the summary counts, exposed as codes rather than as a tally —
    // "DIRECT" is the national placeholder, not a real area, exactly as the summary treats it.
    const soldAreas = new Set(
      dashboard.byArea
        .map((row) => String(row.code ?? "").trim().toUpperCase())
        .filter((code) => code && code !== "DIRECT"),
    );
    const orphanAreas = [...soldAreas].filter((code) => !masterAreas.has(code));

    const problems: string[] = [];
    if (dashboard.summary.totalAreas !== masterAreas.size) {
      problems.push(
        `Areas denominator: the dashboard divides by ${formatCount(dashboard.summary.totalAreas, "area")} but the master holds ${formatCount(masterAreas.size, "active area")}`,
      );
    }
    if (dashboard.summary.totalBricks !== masterBricks.size) {
      problems.push(
        `Bricks denominator: the dashboard divides by ${formatCount(dashboard.summary.totalBricks, "brick")} but the master holds ${formatCount(masterBricks.size, "active brick")}`,
      );
    }
    if (dashboard.summary.areasReached !== soldAreas.size) {
      problems.push(
        `Areas numerator: the summary claims ${formatCount(dashboard.summary.areasReached, "area")} reached but the area breakdown lists ${formatCount(soldAreas.size, "area")}`,
      );
    }
    if (orphanAreas.length > 0) {
      problems.push(
        `${formatCount(orphanAreas.length, "area")} sold into but absent from the master reference, which inflates the coverage ratio: ${formatList(orphanAreas)}`,
      );
    }
    // The brick numerator has no code-level counterpart in the payload (topBricks is capped at 12),
    // so containment is asserted for areas and only the bound for bricks. Stated rather than faked.
    if (dashboard.summary.bricksReached > dashboard.summary.totalBricks) {
      problems.push(
        `Bricks reached (${dashboard.summary.bricksReached}) exceeds bricks in the master (${dashboard.summary.totalBricks}) — the two describe different populations`,
      );
    }

    return {
      left: {
        source: `getSosDashboard({}, systemAccessContext).summary for ${dashboard.period ?? "no period"}`,
        value: `${dashboard.summary.areasReached}/${dashboard.summary.totalAreas} areas, ${dashboard.summary.bricksReached}/${dashboard.summary.totalBricks} bricks`,
      },
      right: {
        source: "source_of_sales_areas / source_of_sales_bricks masters (active), plus the dashboard's own area breakdown",
        value: `${soldAreas.size}/${masterAreas.size} areas, master holds ${masterBricks.size} bricks`,
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `Coverage for ${dashboard.period ?? "the latest period"} measures ${soldAreas.size} sold areas against ${masterAreas.size} master areas, with every sold area present in the master.`
          : formatList(problems),
    };
  }),
};

export const crmSalesReconciliationChecks: ReconciliationCheck[] = [
  topCustomersListEachCustomerOnce,
  coverageNumeratorInsideMasterDenominator,
];
