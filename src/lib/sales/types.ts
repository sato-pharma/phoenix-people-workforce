/* eslint-disable @typescript-eslint/no-explicit-any */

export type SalesValidationState = "valid" | "warning" | "failed";
export type SalesLinkStatus = "linked" | "unlinked" | "ambiguous";

export type EmployeeDirectoryRow = {
  area: string | null;
  crm_id: string | null;
  crm_username: string | null;
  employment_status: string | null;
  full_name: string | null;
  hr_id: string;
  job_title?: string | null;
  line: string | null;
  manager_hr_id?: string | null;
  position_title?: string | null;
  region: string | null;
};

export type SalesRecordInput = Record<string, any> & {
  batchId?: string;
  employeeCrmId?: string | null;
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  factoryPrice: number;
  family: string;
  line: string;
  linkConfidence?: number;
  linkStatus?: SalesLinkStatus;
  managerHrId?: string | null;
  month: number;
  product: string;
  rowNumber: number;
  salesType: string;
  salesUnits: number;
  salesValue: number;
  targetUnits: number;
  targetValue: number;
  territory: string;
  validationNotes: string[];
  validationState: SalesValidationState;
  year: number;
};

export type TargetRecord = Record<string, any> & {
  batchId: string;
  employeeCrmId?: string | null;
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  id: string;
  line: string;
  month: number;
  status: SalesValidationState;
  targetUnits: number;
  targetValue: number;
  validationNotes: string[];
  year: number;
};

export type SalesBatch = Record<string, any> & {
  approvalBlockedReason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  canApprove: boolean;
  createdAt: string;
  duplicateHash?: string;
  failedRecords: number;
  fileName: string;
  id: string;
  isDuplicate: boolean;
  line: string;
  linkedRecords: number;
  linkageRate: number;
  month: number;
  period: string;
  previewUrl: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  replacedByBatchId: string | null;
  replacementForBatchId: string | null;
  schemaType?: string;
  status: string;
  totalRecords: number;
  uploadedBy: string;
  validRecords: number;
  version?: number;
  warningRecords: number;
  year: number;
};

export type TargetBatch = Record<string, any> & {
  createdAt?: string;
  failedRecords: number;
  fileName: string;
  id: string;
  month: number;
  status: string;
  totalRecords: number;
  validRecords: number;
  year: number;
};
export type SalesBatchDetail = Record<string, any>;
export type SalesBatchIssue = Record<string, any>;
export type SalesBatchReconciliation = Record<string, any>;
export type SalesTrendPoint = {
  achievementRate: number;
  linkedEmployees: number;
  period: string;
  sales: number;
  target: number;
};

export type SalesProductPerformanceRow = {
  achievementRate: number;
  family: string;
  product: string;
  sales: number;
  target: number;
};

export type SalesDashboardFilterOptions = {
  families: string[];
  lines: string[];
  managers: string[];
  periods: string[];
  products: string[];
  salesTypes: string[];
  territories: string[];
};

export type SalesDashboardData = {
  [key: string]: any;
  anomalies: Array<Record<string, any>>;
  familyMatrix: Array<Record<string, any>>;
  filters: SalesDashboardFilterOptions;
  managerPerformance: Array<Record<string, any>>;
  productPerformance: SalesProductPerformanceRow[];
  recentBatches: Array<Record<string, any>>;
  summary: Record<string, any>;
  territories: Array<Record<string, any>>;
  trend: SalesTrendPoint[];
};
export type SalesDashboardFilters = Partial<{
  family: string;
  line: string;
  manager: string;
  period: string;
  product: string | string[];
  products: string[];
  salesType: string;
  territory: string;
}>;
export type SalesHistoryRow = Record<string, any>;

export type SalesImportPayload = {
  batch: SalesBatch;
  records: SalesRecordInput[];
};

export type TargetUploadPayload = {
  batch: TargetBatch;
  records: TargetRecord[];
};
