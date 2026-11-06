export type VisitsSyncTrigger = "cron" | "manual" | "manual_backfill";
export type VisitsSyncStatus = "running" | "success" | "failed";
export type VisitsMappingStatus = "agent_unmapped" | "double_unmapped" | "either_unmapped" | "fully_mapped";

/** Where a visit's canonical time came from: the GPS check-in (real on-site presence), the rep's
 * save/submission time (a proxy — often logged hours later or the next morning), or none. */
export type VisitTimeSource = "gps_checkin" | "save_time" | "none";

export type VisitsReportRow = {
  agentCrmId: number;
  agentHrId: string | null;
  agentName: string | null;
  ampm: string | null;
  attendance: number | null;
  callType: number | null;
  comment: string | null;
  contactCrmId: number | null;
  contactName: string | null;
  crmSaveDate: string | null;
  crmVisitId: number;
  customerName: string | null;
  /** SLOT 1 — the first person beside the rep: the manager who rode along, else the product manager,
   * else the senior. A vendor row records one partner and this is it. */
  doubleCrmId: number | null;
  doubleHrId: string | null;
  doubleName: string | null;
  /** SLOT 2 — the chain's OTHER person: the senior above the manager, or the product manager who came
   * with him. Always null on a vendor row, which has one partner column; set only on a Phoenix CRM
   * row. Slot 2 is never filled while slot 1 is empty, so "was anybody out with him" is still answered
   * by slot 1 alone. Added 2026-10-07: before it a chain visit lost its second person and a
   * product-manager visit carried nobody at all, which is why 18 of Ahmed SharafEldeen's visits read
   * as a day he did not work. */
  double2CrmId: number | null;
  double2HrId: string | null;
  double2Name: string | null;
  id: string;
  /** Nearest same-day, same-agent GPS check-in — a best-effort correlation, never a guaranteed match. */
  nearestCheckinAddress: string | null;
  nearestCheckinTime: string | null;
  visitDate: string;
  visitDateTime: string | null;
  /** The ONE authoritative visit time (Africa/Cairo wall-clock — render with NO timezone shift):
   * the matched GPS check-in time when present, else the rep's save/submission time. NEVER the
   * `visit_date_time` midnight placeholder. Computed via resolveVisitTime in the CRM read layer. */
  visitTime: string | null;
  visitTimeSource: VisitTimeSource;
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
  /** Visits a mapping left unassigned because they predate the person's hire date, as a sentence. */
  notice: string | null;
  resolvedEmployeeHrId: string | null;
  resolvedEmployeeName: string | null;
  updatedVisits: number;
};
