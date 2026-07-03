export type VisitsSyncTrigger = "cron" | "manual" | "manual_backfill";
export type VisitsSyncStatus = "running" | "success" | "failed";

export type VisitsReportRow = {
  agentCrmId: number;
  agentHrId: string | null;
  agentName: string | null;
  ampm: string | null;
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
  visitDate: string;
  visitType: number | null;
  visitTypeDescription: string | null;
};

export type VisitsSyncRun = {
  completedAt: string | null;
  dateFrom: string;
  dateTo: string;
  errorMessage: string | null;
  id: string;
  rowsFetched: number;
  rowsUpserted: number;
  startedAt: string;
  status: VisitsSyncStatus;
  trigger: VisitsSyncTrigger;
};

export type VisitsReportAgentFilter = {
  hrId: string;
  name: string;
};

export type VisitsReportData = {
  configured: boolean;
  dateFrom: string;
  dateTo: string;
  filters: {
    agents: VisitsReportAgentFilter[];
  };
  latestSyncRuns: VisitsSyncRun[];
  page: number;
  pageSize: number;
  rows: VisitsReportRow[];
  schemaReady: boolean;
  totalCount: number;
};
