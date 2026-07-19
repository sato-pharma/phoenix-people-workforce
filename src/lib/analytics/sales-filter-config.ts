// Sales analytics filter descriptors — one config drives all three pipelines.
// Import the relevant subset per dashboard page.

import type { FilterDescriptor } from "./filter-registry";

// ── Shared time filters ───────────────────────────────────────────────────────

export const PERIOD_FILTER: FilterDescriptor = {
  key: "period",
  label: "Period (Month)",
  type: "multi-select",
  source: "periods",
  multiple: true,
  placeholder: "All periods",
  pipeline: "all",
};

export const PERIOD_FROM_FILTER: FilterDescriptor = {
  key: "periodFrom",
  label: "From Period",
  type: "single-select",
  source: "periods",
  placeholder: "Earliest",
  pipeline: "all",
};

export const PERIOD_TO_FILTER: FilterDescriptor = {
  key: "periodTo",
  label: "To Period",
  type: "single-select",
  source: "periods",
  placeholder: "Latest",
  pipeline: "all",
};

// Weekly-only: analytics_weekly_fact accepts p_year, but the SoS / Closing / Executive RPCs are
// period-scoped (YYYY-MM) and ignore year — so YEAR_FILTER belongs only in WEEKLY_FILTERS. Adding
// it to a period-scoped set produces a dead, no-op control.
export const YEAR_FILTER: FilterDescriptor = {
  key: "year",
  label: "Year",
  type: "multi-select",
  source: "static",
  multiple: true,
  staticOptions: [
    { value: "2025", label: "2025" },
    { value: "2026", label: "2026" },
    { value: "2027", label: "2027" },
  ],
  pipeline: "weekly",
};

export const WEEK_FILTER: FilterDescriptor = {
  key: "week",
  label: "Week",
  type: "multi-select",
  source: "weeks",
  multiple: true,
  placeholder: "All weeks",
  pipeline: "weekly",
};

// ── Geography filters ─────────────────────────────────────────────────────────

export const REGION_FILTER: FilterDescriptor = {
  key: "regions",
  label: "Region",
  type: "multi-select",
  source: "regions",
  multiple: true,
  placeholder: "All regions",
  pipeline: ["sos", "weekly"],
};

export const AREA_FILTER: FilterDescriptor = {
  key: "areas",
  label: "Area",
  type: "multi-select",
  source: "areas",
  multiple: true,
  placeholder: "All areas",
  pipeline: "sos",
};

// ── Distributor filters ───────────────────────────────────────────────────────

export const DISTRIBUTOR_FILTER: FilterDescriptor = {
  key: "distributors",
  label: "Distributor",
  type: "multi-select",
  source: "distributors",
  multiple: true,
  placeholder: "All distributors",
  pipeline: ["sos", "weekly"],
};

// ── Product / line / family filters ──────────────────────────────────────────

export const LINE_FILTER: FilterDescriptor = {
  key: "lines",
  label: "Line",
  type: "multi-select",
  source: "lines",
  multiple: true,
  placeholder: "All lines",
  pipeline: "all",
};

export const PRODUCT_FILTER: FilterDescriptor = {
  key: "products",
  label: "Product",
  type: "multi-select",
  source: "products",
  multiple: true,
  placeholder: "All products",
  pipeline: "all",
};

export const FAMILY_FILTER: FilterDescriptor = {
  key: "families",
  label: "Product Family",
  type: "multi-select",
  source: "families",
  multiple: true,
  placeholder: "All families",
  pipeline: "all",
};

// ── Channel filter (SoS only) ─────────────────────────────────────────────────

export const CHANNEL_FILTER: FilterDescriptor = {
  key: "channel",
  label: "Channel",
  type: "multi-select",
  source: "static",
  multiple: true,
  staticOptions: [
    { value: "Distributor", label: "Distributor" },
    { value: "Direct", label: "Direct" },
  ],
  placeholder: "All channels",
  pipeline: "sos",
};

// ── Employee / manager (closing only) ────────────────────────────────────────

export const EMPLOYEE_FILTER: FilterDescriptor = {
  key: "employeeHrId",
  label: "Employee (HR ID)",
  type: "text-search",
  source: "employees",
  placeholder: "Search by HR ID or name",
  pipeline: "closing",
};

export const TERRITORY_FILTER: FilterDescriptor = {
  key: "territory",
  label: "Territory",
  type: "text-search",
  source: "territories",
  placeholder: "Territory name",
  pipeline: "closing",
};

// ── Customer (SoS only — presence, not invoice rows) ─────────────────────────

export const CUSTOMER_FILTER: FilterDescriptor = {
  key: "clientCodes",
  label: "Customer",
  type: "multi-select",
  source: "customers",
  multiple: true,
  placeholder: "All customers",
  pipeline: "sos",
};

// ── Batch (closing only) ─────────────────────────────────────────────────────
// NOTE: no Batch Status filter by design. The analytics.closing_fact view is hard-filtered to
// approved batches (WHERE b.status = 'approved'), so Staged/Rejected options would always return
// zero rows. Closing analytics reflects APPROVED closings only.

export const BATCH_ID_FILTER: FilterDescriptor = {
  key: "batchId",
  label: "Batch",
  type: "text-search",
  source: "static",
  placeholder: "Batch UUID",
  pipeline: "closing",
};

// ── Pre-built sets per dashboard ──────────────────────────────────────────────

export const SOS_FILTERS: FilterDescriptor[] = [
  // SoS RPCs are period-scoped and do not accept p_year; do not expose a no-op year control here.
  PERIOD_FILTER,
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  DISTRIBUTOR_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  AREA_FILTER,
  PRODUCT_FILTER,
  FAMILY_FILTER,
  CHANNEL_FILTER,
  CUSTOMER_FILTER,
];

// The Customers tab reads analytics_sos_by_customer, which only accepts period / line / region /
// customer filters. Expose ONLY those so the controls aren't dead — distributor / area / product /
// family / channel are silently ignored by that RPC.
export const SOS_CUSTOMER_FILTERS: FilterDescriptor[] = [
  PERIOD_FILTER,
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  CUSTOMER_FILTER,
];

export const CLOSING_FILTERS: FilterDescriptor[] = [
  // Closing RPCs are period/date-scoped and do not accept p_year; do not expose a no-op year control here.
  PERIOD_FILTER,
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  LINE_FILTER,
  PRODUCT_FILTER,
  FAMILY_FILTER,
  EMPLOYEE_FILTER,
  TERRITORY_FILTER,
  BATCH_ID_FILTER,
];

export const WEEKLY_FILTERS: FilterDescriptor[] = [
  WEEK_FILTER,
  YEAR_FILTER,
  DISTRIBUTOR_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  PRODUCT_FILTER,
  FAMILY_FILTER,
];

export const EXECUTIVE_FILTERS: FilterDescriptor[] = [
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  DISTRIBUTOR_FILTER,
];

// analytics_cross_source only accepts p_period_from / p_period_to / p_lines (see
// loadCrossSourceUncached in service.ts) — Region and Distributor are NOT forwarded by
// reconciliation-dashboard.tsx's query object, so reusing EXECUTIVE_FILTERS here would render two
// controls that silently do nothing when changed. Use this narrower set instead.
export const RECONCILIATION_FILTERS: FilterDescriptor[] = [
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  LINE_FILTER,
];
