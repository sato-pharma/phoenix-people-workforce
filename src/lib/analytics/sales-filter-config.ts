// Sales analytics filter descriptors — one config drives all three pipelines.
// Import the relevant subset per dashboard page.

import type { FilterDescriptor } from "./filter-registry";

// ── Shared time filters ───────────────────────────────────────────────────────

export const PERIOD_FILTER: FilterDescriptor = {
  key: "period",
  label: "Period (Month)",
  type: "single-select",
  source: "periods",
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

export const YEAR_FILTER: FilterDescriptor = {
  key: "year",
  label: "Year",
  type: "single-select",
  source: "static",
  staticOptions: [
    { value: "2025", label: "2025" },
    { value: "2026", label: "2026" },
    { value: "2027", label: "2027" },
  ],
  pipeline: "all",
};

export const WEEK_FILTER: FilterDescriptor = {
  key: "week",
  label: "Week",
  type: "single-select",
  source: "weeks",
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
  type: "single-select",
  source: "static",
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

// ── Batch (closing only — real workflow states: staged/approved/rejected) ────

export const BATCH_STATUS_FILTER: FilterDescriptor = {
  key: "batchStatus",
  label: "Batch Status",
  type: "multi-select",
  source: "batchStatuses",
  multiple: true,
  staticOptions: [
    { value: "staged", label: "Staged" },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
  ],
  placeholder: "All statuses",
  pipeline: "closing",
};

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
  PERIOD_FILTER,
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  YEAR_FILTER,
  DISTRIBUTOR_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  AREA_FILTER,
  PRODUCT_FILTER,
  FAMILY_FILTER,
  CHANNEL_FILTER,
  CUSTOMER_FILTER,
];

export const CLOSING_FILTERS: FilterDescriptor[] = [
  PERIOD_FILTER,
  PERIOD_FROM_FILTER,
  PERIOD_TO_FILTER,
  YEAR_FILTER,
  LINE_FILTER,
  PRODUCT_FILTER,
  FAMILY_FILTER,
  EMPLOYEE_FILTER,
  TERRITORY_FILTER,
  BATCH_STATUS_FILTER,
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
  YEAR_FILTER,
  LINE_FILTER,
  REGION_FILTER,
  DISTRIBUTOR_FILTER,
];
