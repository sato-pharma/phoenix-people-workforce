// Sales Operations Module — centralized route constants.
//
// Single source of truth for the module's hrefs. Components, redirects and cross-links import from
// here instead of hard-coding "/sales-operations/..." strings (designing out the old module's
// scattered <Link href="/sales/import"> coupling). The sidebar nav in system-navigation.ts uses the
// same literals; keep them in sync with this constant.

export const SALES_OPS_ROUTES = {
  dashboard: "/sales-operations",
  upload: "/sales-operations/upload",
  mapping: "/sales-operations/mapping",
  diagnostics: "/sales-operations/diagnostics",
} as const;

export type SalesOpsRoute = (typeof SALES_OPS_ROUTES)[keyof typeof SALES_OPS_ROUTES];
