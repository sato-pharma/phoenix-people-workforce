/**
 * @deprecated Re-export shim. The admin (unmapped-identity) reads and the Visits Report view were
 * relocated into the `@/lib/crm/*` module as part of centralizing all iReports360 access behind one
 * CRM domain. Import from `@/lib/crm/admin` or `@/lib/crm/reads` directly; this shim only keeps
 * existing importers working and will be removed once every consumer is repointed. (The sync
 * engine it also re-exported was removed with the retired vendor, 2026-11-06.)
 */

export {
  getLatestVisitsSyncRuns,
  getUnmappedCrmIdentities,
  setUnmappedCrmIdentityResolution,
} from "@/lib/crm/admin";

export { getVisitsReportData, getVisitsReportExportRows, mapVisitRow } from "@/lib/crm/reads";
