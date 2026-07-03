export type EmployeeImportField =
  | "hrId"
  | "crmId"
  | "crmUsername"
  | "fullName"
  | "nickname"
  | "nameAr"
  | "nationalId"
  | "gender"
  | "workEmail"
  | "mobileNumber"
  | "jobTitle"
  | "hireDate"
  | "birthDate"
  | "education"
  | "employmentStatus"
  | "payrollEligible"
  | "organogramVisible"
  | "managerHrId"
  | "managerName"
  | "contractType"
  | "hasBankAccount"
  | "bankName"
  | "bankAccount"
  | "socialInsuranceStatus"
  | "socialInsuranceNumber"
  | "medicalInsuranceStatus"
  | "medicalInsuranceNumber"
  | "basicSalary"
  | "baseSalary"
  | "netSalary"
  | "socialInsurance"
  | "taxes"
  | "medicalInsurance"
  | "fuelAllowance"
  | "extraCostOfLiving"
  | "grossSalary"
  | "paymentMode"
  | "department"
  | "line"
  | "region"
  | "area"
  | "team"
  | "position"
  | "residenceAddress"
  | "residenceCity"
  | "residenceArea";

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
  rowType: "employee" | "vacant_position";
  source: RawEmployeeImportRow;
  hrId: string | null;
  crmId: string | null;
  crmUsername: string | null;
  fullName: string | null;
  nickname: string | null;
  nameAr: string | null;
  nationalId: string | null;
  gender: string | null;
  workEmail: string | null;
  mobileNumber: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  birthDate: string | null;
  education: string | null;
  employmentStatus: string | null;
  payrollEligible: string | null;
  organogramVisible: string | null;
  managerHrId: string | null;
  managerName: string | null;
  contractType: string | null;
  hasBankAccount: string | null;
  bankName: string | null;
  bankAccount: string | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  compensation: {
    basicSalary: number | null;
    baseSalary: number | null;
    extraCostOfLiving: number | null;
    fuelAllowance: number | null;
    grossSalary: number | null;
    medicalInsurance: number | null;
    netSalary: number | null;
    paymentMode: string | null;
    socialInsurance: number | null;
    taxes: number | null;
  };
  departmentName: string | null;
  lineName: string | null;
  regionName: string | null;
  regionCode: string | null;
  areaName: string | null;
  teamName: string | null;
  positionTitle: string | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  residenceArea: string | null;
  normalizedOrganizationNames: {
    department: string | null;
    line: string | null;
    area: string | null;
    team: string | null;
    position: string | null;
  };
  rawOrganizationValues: {
    department: string | null;
    line: string | null;
    area: string | null;
    team: string | null;
    position: string | null;
  };
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
  normalizedName?: string | null;
  parentCode?: string;
  rawValuesMerged: string[];
};

export type OrganizationEntitiesToCreate = {
  areas: OrganizationEntityToCreate[];
  departments: OrganizationEntityToCreate[];
  lines: OrganizationEntityToCreate[];
  positions: OrganizationEntityToCreate[];
  teams: OrganizationEntityToCreate[];
};

export type OrganizationEntityCounts = {
  area: number;
  department: number;
  line: number;
  position: number;
  team: number;
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
  vacantRows: number;
  detectedColumns: DetectedEmployeeColumn[];
  missingRequiredColumns: EmployeeImportField[];
  duplicateHrIds: string[];
  rowsToInsert: EmployeeImportRecord[];
  rowsToUpdate: EmployeeImportRecord[];
  vacantPositionsToCreate: VacantPositionImportRecord[];
  organizationEntitiesToCreate: OrganizationEntitiesToCreate;
  organizationEntityCounts: OrganizationEntityCounts;
  orgMappingWarnings: unknown[];
  sampleOrgMappings: unknown[];
  validationErrors: EmployeeImportIssue[];
  validationWarnings: EmployeeImportIssue[];
};

export type VacantPositionImportRecord = EmployeeImportRecord & {
  rowType: "vacant_position";
};

export type ExistingImportState = {
  areaCodeToId?: Map<string, number>;
  crmIdToHrId?: Map<string, string>;
  crmUsernameToHrId?: Map<string, string>;
  employeeOrgSeats?: ExistingEmployeeOrgSeat[];
  employeeHrIds?: Set<string>;
  managerHrIds?: Set<string>;
  terminalEmployeeHrIds?: Set<string>;
  protectedLifecycleHrIds?: Set<string>;
  departmentCodes?: Set<string>;
  departmentCodeToName?: Map<string, string>;
  departmentNameToCode?: Map<string, string>;
  lineCodes?: Set<string>;
  lineCodeToId?: Map<string, number>;
  areaCodes?: Set<string>;
  /** (lineCode|areaCode) -> region_code, from public.line_area_region_map. */
  regionCodeByLineArea?: Map<string, string>;
  teamCodes?: Set<string>;
  teamCodeToTeam?: Map<string, ExistingTeamLookup>;
  teamNameAreaToTeam?: Map<string, ExistingTeamLookup>;
  teamNameToTeams?: Map<string, ExistingTeamLookup[]>;
  positionCodes?: Set<string>;
};

export type ExistingEmployeeOrgSeat = {
  areaCode: string | null;
  hrId: string;
  jobTitle: string | null;
  lineCode: string | null;
  positionCode: string | null;
  regionName: string | null;
  regionCode: string | null;
};

export type ExistingTeamLookup = {
  areaCode: string | null;
  code: string;
  id: number;
  name: string;
};

export type EmployeeImportPlanOptions = {
  headerRowNumber?: number;
  firstDataRowNumber?: number;
  existingState?: ExistingImportState;
  useOrgRuleEngine?: boolean;
};
