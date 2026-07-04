export type VisitsSyncTrigger = "cron" | "manual" | "manual_backfill";
export type VisitsSyncStatus = "running" | "success" | "failed";
export type VisitsMappingStatus = "agent_unmapped" | "double_unmapped" | "either_unmapped" | "fully_mapped";

export type VisitsReportRow = {
  agentCrmId: number;
  agentHrId: string | null;
  agentName: string | null;
  ampm: string | null;
  attendance: number | null;
  callType: number | null;
  comment: string | null;
  contactName: string | null;
  crmSaveDate: string | null;
  crmVisitId: number;
  customerName: string | null;
  doubleCrmId: number | null;
  doubleHrId: string | null;
  doubleName: string | null;
  id: string;
  /** Nearest same-day, same-agent GPS check-in — a best-effort correlation, never a guaranteed match. */
  nearestCheckinAddress: string | null;
  nearestCheckinTime: string | null;
  visitDate: string;
  visitDateTime: string | null;
  visitType: number | null;
  visitTypeDescription: string | null;
};

export type VisitsReportFilterInput = {
  // Matches against agent_name — the filter dropdown is built from distinct agent names
  // (there is no reliable single "agent HR ID" to filter by when many rows are unmapped).
  agentName?: string | null;
  ampm?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  mappingStatus?: VisitsMappingStatus | null;
  search?: string | null;
  visitType?: string | null;
};

export type VisitsSyncRun = {
  completedAt: string | null;
  dateFrom: string;
  dateTo: string;
  errorMessage: string | null;
  id: string;
  /** Rows removed from ireports360_visits by this run's delete-reconciliation (present in the
   * mirror for this run's window but absent from the fresh CRM fetch — voided/deleted upstream). */
  rowsDeleted: number;
  rowsFetched: number;
  /** Visits this run fetched but did not upsert because the CRM returned a missing/invalid visitDate. */
  rowsSkippedInvalidDate: number;
  /** Stale rows this run found but did NOT delete because they exceeded the 50% sanity cap —
   * a signal the fetch may have been partial/truncated rather than reflecting real deletions. */
  rowsSkippedReconcile: number;
  rowsUpserted: number;
  startedAt: string;
  status: VisitsSyncStatus;
  trigger: VisitsSyncTrigger;
};

export type VisitsReportData = {
  configured: boolean;
  dateFrom: string;
  dateTo: string;
  filters: {
    agents: string[];
    visitTypes: string[];
  };
  latestSyncRuns: VisitsSyncRun[];
  page: number;
  pageSize: number;
  rows: VisitsReportRow[];
  schemaReady: boolean;
  totalCount: number;
};

export type VisitsReportExportResult = {
  rows: VisitsReportRow[];
  totalCount: number;
  truncated: boolean;
};

/** One row per unmapped CRM identity (crm_id) — a punch-list for fixing
 * employees.crm_id/crm_username, rolled up from every visit/double-visit row where that
 * identity currently has no resolved HR ID. */
export type UnmappedCrmIdentityRow = {
  crmId: number;
  firstSeen: string;
  lastSeen: string;
  name: string;
  roles: Array<"agent" | "double">;
  visitCount: number;
};

/** Admin resolution for a CRM identity that never auto-maps: resigned (hide, leave
 * unmapped), mapped (apply a specific employees.hr_id), or pending (default, keep showing). */
export type UnmappedCrmResolutionAction = "mapped" | "pending" | "resigned";

export type UnmappedCrmResolutionResult = {
  resolvedEmployeeHrId: string | null;
  resolvedEmployeeName: string | null;
  updatedVisits: number;
};
