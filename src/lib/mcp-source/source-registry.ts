import type { SourceSpec } from "./source-proof";

/**
 * What each MCP dataset reads, and which change-watermark sources guard those reads.
 *
 * The watermark source names are the keys of `proposal/source-watermark.sql` in infra/phoenix-mcp;
 * the two lists must agree and tests pin that. A relation or function that a loader reads but that is
 * missing from `coverage` makes the proof refuse (`unwatched_read`) — so when a loader starts reading
 * something new, the dataset stops publishing until someone decides how that read is guarded, rather
 * than publishing data nobody is watching. The first non-production rehearsal is expected to surface
 * every such gap; that is the point of failing closed.
 */

/** The seat model behind `au_v_org_tree`, `au_v_line_area_map*`, `au_v_regions`, `au_v_seat_occupancy_all`. */
const SEATS = ["au_seats", "au_occupancy", "au_canonical_areas", "au_regions", "au_lines", "au_line_area_map"] as const;
const LOOKUPS = ["departments", "lines", "areas", "positions", "teams"] as const;

const lookupCoverage = Object.fromEntries(LOOKUPS.map((name) => [name, [name]]));

const seatCoverage = {
  au_v_org_tree: [...SEATS],
  au_v_line_area_map: ["au_line_area_map", "au_canonical_areas"],
  au_v_line_area_map_all: ["au_line_area_map", "au_canonical_areas"],
  au_v_regions: ["au_regions"],
  au_v_seat_occupancy_all: ["au_occupancy"],
};

export const EMPLOYEES_SPEC: SourceSpec = {
  dataset: "employees",
  watched: ["employees", ...LOOKUPS],
  coverage: { employees: ["employees"], ...lookupCoverage },
  required: ["employees"],
};

export const ORGANIZATION_SPEC: SourceSpec = {
  dataset: "organization",
  watched: [...SEATS, "employees", "offers", "position_vacancies", ...LOOKUPS],
  coverage: { ...seatCoverage, ...lookupCoverage, employees: ["employees"], offers: ["offers"], position_vacancies: ["position_vacancies"] },
  required: ["au_v_org_tree", "employees"],
};

export const VACANCIES_SPEC: SourceSpec = {
  dataset: "vacancies",
  watched: [...SEATS, "employees", "offers", "position_vacancies", ...LOOKUPS],
  coverage: { ...seatCoverage, ...lookupCoverage, employees: ["employees"], offers: ["offers"], position_vacancies: ["position_vacancies"] },
  required: ["au_v_org_tree", "position_vacancies"],
};

const SALES_WATCHED = [
  "monthly_closing_publications",
  "monthly_closing_locks",
  "source_of_sales_import_batches",
  "source_of_sales_import_rows",
  "source_of_sales_fact_rollup",
  "source_of_sales_channel_customer_rollup",
  "source_of_sales_distributor_product_rollup",
  "source_of_sales_customer_map",
  "source_of_sales_bricks",
  "source_of_sales_regions",
  "source_of_sales_areas",
  "source_of_sales_distributors",
  "source_of_sales_products",
  "source_of_sales_product_price_history",
  "au_monthly_targets",
  "au_monthly_store_split_net",
  "au_direct_region_allocation",
  "employees",
  ...SEATS,
] as const;

const closingFacts = [
  "source_of_sales_import_batches",
  "source_of_sales_import_rows",
  "source_of_sales_fact_rollup",
  "source_of_sales_channel_customer_rollup",
  "source_of_sales_distributor_product_rollup",
  "source_of_sales_customer_map",
  "source_of_sales_products",
  "source_of_sales_product_price_history",
  "au_monthly_targets",
  "au_direct_region_allocation",
  "employees",
  ...SEATS,
];

export const SALES_SPEC: SourceSpec = {
  dataset: "published_sales",
  watched: [...SALES_WATCHED],
  coverage: {
    ...seatCoverage,
    employees: ["employees"],
    monthly_closing_publications: ["monthly_closing_publications"],
    monthly_closing_locks: ["monthly_closing_locks"],
    phx_closing_customers: closingFacts,
    phx_closing_brick: closingFacts,
    phx_closing_corrections: closingFacts,
    phx_closing_distributor_product: closingFacts,
    phx_closing_channel_totals: closingFacts,
    phx_closing_channel_breakdown: closingFacts,
    phx_monthly_store_split_net: ["au_monthly_store_split_net", ...closingFacts],
    phx_monthly_targets: ["au_monthly_targets"],
    source_of_sales_products: ["source_of_sales_products", "source_of_sales_product_price_history"],
    source_of_sales_bricks: ["source_of_sales_bricks"],
    source_of_sales_regions: ["source_of_sales_regions"],
    source_of_sales_areas: ["source_of_sales_areas"],
    source_of_sales_distributors: ["source_of_sales_distributors"],
    source_of_sales_customer_map: ["source_of_sales_customer_map"],
    source_of_sales_import_batches: ["source_of_sales_import_batches"],
    source_of_sales_import_rows: ["source_of_sales_import_rows"],
    au_v_direct_region_allocation: ["au_direct_region_allocation"],
  },
  required: ["monthly_closing_publications", /^phx_closing_/],
};

/** The cheap, narrow check that a sales month is still published (or provably no longer is). */
export const SALES_PUBLICATION_SPEC: SourceSpec = {
  dataset: "published_sales",
  watched: ["monthly_closing_publications"],
  coverage: { monthly_closing_publications: ["monthly_closing_publications"] },
  required: ["monthly_closing_publications"],
};

export const SPECS = {
  employees: EMPLOYEES_SPEC,
  organization: ORGANIZATION_SPEC,
  vacancies: VACANCIES_SPEC,
  published_sales: SALES_SPEC,
} as const;
