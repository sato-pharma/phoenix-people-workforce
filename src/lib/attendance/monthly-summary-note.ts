// The attendance reporting-cycle note, split out of monthly-summary.ts into its own dependency-free
// module for the same reason official-lines.ts and confidential-products.ts are: the Monthly
// Attendance Summary screen is a CLIENT component and only needs this one string, but monthly-
// summary.ts pulls a server-only chain (fingerprint-report -> crm-day-maps -> crm/reads ->
// employee-directory -> employee-photo -> node:crypto) that webpack refuses to put in a browser
// bundle. Re-exported from monthly-summary.ts unchanged so every existing server caller (and
// monthly-summary-export.ts) keeps importing it from where it already does.

export const attendanceMonthlyCycleNote =
  "Attendance reporting cycle note: payroll attendance months run from day 25 to day 25.";
