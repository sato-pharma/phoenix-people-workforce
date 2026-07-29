import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PERIOD_FILTER, CHANNEL_FILTER, WEEK_FILTER, YEAR_FILTER } from "../src/lib/analytics/sales-filter-config.ts";

// Period / Channel / Week / Year were the last single-value analytics filters — every other
// filter (Line, Region, Distributor, Product, Family, Customer) already supported picking
// several values. This pins the multi-select conversion end to end: the descriptor config,
// every dashboard's array-shaped filter building, and the "prior period/week" comparison
// gate (which only has a coherent meaning for a SINGLE selected period/week).

// period/channel appear only on SoS + Closing dashboards (via SOS_FILTERS / SOS_CUSTOMER_FILTERS /
// CLOSING_FILTERS); channel is SoS-only (analytics_sos_by_customer and closing have no channel column).
const PERIOD_DASHBOARDS = [
  "source-sales-dashboard.tsx",
  "source-sales-by-line-dashboard.tsx",
  "source-sales-by-area-dashboard.tsx",
  "source-sales-by-product-dashboard.tsx",
  "source-sales-by-customer-dashboard.tsx",
  "monthly-closing-dashboard.tsx",
  "monthly-closing-by-employee-dashboard.tsx",
  "monthly-closing-by-line-dashboard.tsx",
];
const CHANNEL_DASHBOARDS = [
  "source-sales-dashboard.tsx",
  "source-sales-by-line-dashboard.tsx",
  "source-sales-by-area-dashboard.tsx",
  "source-sales-by-product-dashboard.tsx",
];
const WEEK_YEAR_DASHBOARDS = [
  "weekly-sales-dashboard.tsx",
  "weekly-sales-detail-dashboard.tsx",
  "weekly-sales-by-distributor-dashboard.tsx",
];

function readDashboard(file: string): string {
  return readFileSync(`src/components/analytics/dashboards/${file}`, "utf8");
}

export function runAnalyticsMultiSelectTimeFiltersTests() {
  // ── Descriptor config: Period / Channel / Week / Year are multi-select ──────
  for (const [name, descriptor] of [
    ["PERIOD_FILTER", PERIOD_FILTER],
    ["CHANNEL_FILTER", CHANNEL_FILTER],
    ["WEEK_FILTER", WEEK_FILTER],
    ["YEAR_FILTER", YEAR_FILTER],
  ] as const) {
    assert.equal(descriptor.type, "multi-select", `${name} must be multi-select`);
  }
  // From/To Period stay single-value — they define a continuous range, not a pick-list.
  const config = readFileSync("src/lib/analytics/sales-filter-config.ts", "utf8");
  assert.match(
    config,
    /PERIOD_FROM_FILTER: FilterDescriptor = \{[\s\S]{0,120}type: "single-select"/,
    "PERIOD_FROM_FILTER must remain single-select (range start)",
  );
  assert.match(
    config,
    /PERIOD_TO_FILTER: FilterDescriptor = \{[\s\S]{0,120}type: "single-select"/,
    "PERIOD_TO_FILTER must remain single-select (range end)",
  );

  // ── Every dashboard builds period/channel/week/year as arrays, not scalars ──
  for (const file of PERIOD_DASHBOARDS) {
    const src = readDashboard(file);
    assert.ok(
      /period:\s+Array\.isArray\(filters\.period\)/.test(src),
      `${file} must read filters.period as an array`,
    );
    assert.ok(
      !/typeof filters\.period\s*===\s*"string"/.test(src),
      `${file} must not treat filters.period as a scalar`,
    );
  }
  for (const file of CHANNEL_DASHBOARDS) {
    const src = readDashboard(file);
    assert.ok(
      /channel:\s+Array\.isArray\(filters\.channel\)/.test(src),
      `${file} must read filters.channel as an array`,
    );
  }
  for (const file of WEEK_YEAR_DASHBOARDS) {
    const src = readDashboard(file);
    assert.ok(
      /weekStart:\s+Array\.isArray\(filters\.week\)/.test(src),
      `${file} must read filters.week as an array (mapped to weekStart)`,
    );
    assert.ok(
      /year:\s+Array\.isArray\(filters\.year\)\s+\?\s+filters\.year\.map\(Number\)/.test(src),
      `${file} must read filters.year as a string[] and coerce every entry to a number`,
    );
  }

  // ── "Prior period/week" comparison only has a coherent meaning for exactly ONE
  //    selected period/week — must gate on length === 1, and pass the single value
  //    back into the loader wrapped in an array (the loader's filter type is string[]).
  for (const file of ["source-sales-dashboard.tsx", "monthly-closing-dashboard.tsx"]) {
    const src = readDashboard(file);
    assert.ok(
      /scoped\.filters\.period\?\.length === 1/.test(src),
      `${file} must only compute a prior-period delta when exactly one period is selected`,
    );
    assert.ok(
      /shiftPeriod\(scoped\.filters\.period\[0\], 1\)/.test(src),
      `${file} must pass the single selected period (not the whole array) into shiftPeriod`,
    );
    assert.ok(
      /period:\s*\[priorPeriod\]/.test(src),
      `${file} must wrap the computed prior period back into an array for the loader`,
    );
  }
  const weekly = readDashboard("weekly-sales-dashboard.tsx");
  assert.ok(
    /scoped\.filters\.weekStart\?\.length === 1/.test(weekly),
    "weekly-sales-dashboard.tsx must only compute a prior-week delta when exactly one week is selected",
  );
  assert.ok(
    /shiftWeek\(scoped\.filters\.weekStart\[0\], 1\)/.test(weekly),
    "weekly-sales-dashboard.tsx must pass the single selected week into shiftWeek",
  );
  assert.ok(
    /weekStart:\s*\[priorWeek\]/.test(weekly),
    "weekly-sales-dashboard.tsx must wrap the computed prior week back into an array for the loader",
  );

  // ── service.ts: filter types are arrays, RPC calls send the renamed array params ──
  const service = readFileSync("src/lib/analytics/service.ts", "utf8");
  assert.match(service, /export type SosFilters = \{\s*\n\s*period\?: string\[\]/, "SosFilters.period must be string[]");
  assert.match(service, /channel\?: string\[\]/, "SosFilters.channel must be string[]");
  assert.match(service, /export type ClosingFilters = \{\s*\n\s*period\?: string\[\]/, "ClosingFilters.period must be string[]");
  assert.match(service, /export type WeeklyFilters = \{\s*\n\s*weekStart\?: string\[\]/, "WeeklyFilters.weekStart must be string[]");
  assert.match(service, /year\?: number\[\]/, "WeeklyFilters.year must be number[]");
  // p_period (scalar) is intentionally still used by the phx_monthly_achievement call inside
  // loadClosingByEmployeeUncached (rep-level achievement, sourced from the seat-model Targets
  // engine since 2026-07-29) — that RPC is a seat-occupancy snapshot "as of" one period's end,
  // not a range/multi-select query, so it has no array shape to migrate to. Every OTHER call
  // site must still have moved to the array param; only that one call site is allowed to keep
  // the old-looking scalar key.
  for (const match of service.matchAll(/p_period:/g)) {
    const context = service.slice(Math.max(0, match.index - 400), match.index);
    assert.ok(
      /phx_monthly_achievement/.test(context),
      "no RPC call other than phx_monthly_achievement (a single-period snapshot function with no range query shape) may send the old scalar p_period param",
    );
  }
  assert.ok(!/p_channel:/.test(service), "no RPC call may still send the old scalar p_channel param");
  assert.ok(!/p_week_start:/.test(service), "no RPC call may still send the old scalar p_week_start param");
  assert.ok(service.includes("p_periods:"), "RPC calls must send the new array param p_periods");
  assert.ok(service.includes("p_channels:"), "RPC calls must send the new array param p_channels");
  assert.ok(service.includes("p_week_starts:") && service.includes("p_years:"), "weekly RPC call must send p_week_starts + p_years");

  // ── Executive Comparison / Reconciliation never reference the removed YEAR_FILTER path ──
  // (YEAR_FILTER is weekly-only on this branch; EXECUTIVE_FILTERS does not include it.)
  assert.doesNotMatch(config, /EXECUTIVE_FILTERS: FilterDescriptor\[\] = \[[\s\S]*?YEAR_FILTER/, "EXECUTIVE_FILTERS must not include YEAR_FILTER");
}
