export type EmployeeImportField =
  | "hrId"
  | "crmId"
  | "fullName"
  | "nameAr"
  | "workEmail"
  | "mobileNumber"
  | "jobTitle"
  | "hireDate"
  | "education"
  | "managerHrId"
  | "department"
  | "line"
  | "area"
  | "team"
  | "position";

export type OrganizationEntityType =
  | "department"
  | "line"
  | "area"
  | "team"
  | "position";

export type RawEmployeeImportRow = Record<string, unknown>;

export type EmployeeImportColumnDefinition = {
  field: EmployeeImportField;
  dbPath: string;
  required: boolean;
  aliases: string[];
};

export type DetectedEmployeeColumn = {
  field: EmployeeImportField;
  sourceHeader: string;
  normalizedHeader: string;
};

export type EmployeeImportRecord = {
  rowNumber: number;
  source: RawEmployeeImportRow;
  hrId: string | null;
  crmId: string | null;
  fullName: string | null;
  nameAr: string | null;
  workEmail: string | null;
  mobileNumber: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  education: string | null;
  managerHrId: string | null;
  departmentName: string | null;
  lineName: string | null;
  areaName: string | null;
  teamName: string | null;
  positionTitle: string | null;
  codes: {
    departmentCode: string | null;
    lineCode: string | null;
    areaCode: string | null;
    teamCode: string | null;
    positionCode: string | null;
  };
};

export type OrganizationEntityToCreate = {
  type: OrganizationEntityType;
  code: string;
  name: string;
  parentCode?: string;
};

export type EmployeeImportIssue = {
  rowNumber?: number;
  field?: EmployeeImportField;
  code: string;
  message: string;
};

export type EmployeeImportValidationResult = {
  totalRows: number;
  validRows: number;
  warningRows: number;
  failedRows: number;
  detectedColumns: DetectedEmployeeColumn[];
  missingRequiredColumns: EmployeeImportField[];
  duplicateHrIds: string[];
  rowsToInsert: EmployeeImportRecord[];
  rowsToUpdate: EmployeeImportRecord[];
  organizationEntitiesToCreate: OrganizationEntityToCreate[];
  validationErrors: EmployeeImportIssue[];
  validationWarnings: EmployeeImportIssue[];
};

export type ExistingImportState = {
  employeeHrIds?: Set<string>;
  managerHrIds?: Set<string>;
  departmentCodes?: Set<string>;
  lineCodes?: Set<string>;
  areaCodes?: Set<string>;
  teamCodes?: Set<string>;
  positionCodes?: Set<string>;
};

export type EmployeeImportPlanOptions = {
  headerRowNumber?: number;
  firstDataRowNumber?: number;
  existingState?: ExistingImportState;
};
