/**
 * @deprecated Re-export shim. The CRM sync engine, admin (unmapped-identity) reads, and the
 * Visits Report view were relocated into the `@/lib/crm/*` module as part of centralizing all
 * iReports360 access behind one CRM domain. Import from `@/lib/crm/sync`, `@/lib/crm/admin`, or
 * `@/lib/crm/reads` directly; this shim only keeps existing importers working during the
 * migration and will be removed once every consumer is repointed.
 */

export {
  dedupeByKey,
  isValidIsoDate,
  reapStaleIReports360SyncRuns,
  remapUnmatchedHrIds,
  resolveWideReconciliationSlice,
  rowFromVisit,
  runScheduledIReports360Sync,
  runWideIReports360Reconciliation,
  syncIReports360Visits,
  WIDE_RECONCILIATION_SLICE_DAYS,
  WIDE_RECONCILIATION_TOTAL_DAYS,
} from "@/lib/crm/sync";

export {
  getLatestVisitsSyncRuns,
  getUnmappedCrmIdentities,
  setUnmappedCrmIdentityResolution,
} from "@/lib/crm/admin";

export { getVisitsReportData, getVisitsReportExportRows, mapVisitRow } from "@/lib/crm/reads";
