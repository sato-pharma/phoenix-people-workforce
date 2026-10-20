import type { RegionCrosswalk } from "@/lib/employees/region-resolver";
import type { StoredPayFlags } from "@/lib/employees/salary-blind-pay-flags";

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
  | "socialInsuranceJobTitle"
  | "healthCardStatus"
  | "healthCardNumber"
  | "healthCardReceivedDate"
  | "birthPlace"
  | "qualification"
  | "universityName"
  | "collegeMajor"
  | "seniorYear"
  | "contractDuration"
  | "contractRenewalDate"
  | "probationEndDate"
  | "medicalInsuranceCardReceivedDate"
  | "socialInsuranceStartDate"
  | "kaabElamaalNumber"
  | "kaabElamaalIssuer"
  | "kaabElamaalIssueDate"
  | "kaabElamaalRefund"
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
  /**
   * The Arabic job title filed with the Social Insurance Authority.
   *
   * NOT A COLUMN ON `employees`. It is `employee_hiring_profile.job_title_ar`, the value the
   * contract and Form 1 already print, so the confirm step writes it through the hiring profile
   * rather than with the rest of the row.
   */
  socialInsuranceJobTitle: string | null;
  /** The GOVERNMENT health insurance booklet — دفتر التأمين الصحى الحكومى, not the private policy. */
  healthCardStatus: string | null;
  healthCardNumber: string | null;
  healthCardReceivedDate: string | null;
  /**
   * The HR record fields the Employee Master carries since 2026-09-29.
   *
   * All plain columns on `employees`, all nullable, none of them a rule: no payroll figure, no
   * eligibility and no statutory filing is derived from any of them. `qualification` is the
   * qualification (بكالوريوس / ليسانس); the COLLEGE stays `education`, which is what it has always
   * held and what the eligible-degree rule reads.
   */
  birthPlace: string | null;
  qualification: string | null;
  universityName: string | null;
  collegeMajor: string | null;
  seniorYear: string | null;
  contractDuration: string | null;
  contractRenewalDate: string | null;
  probationEndDate: string | null;
  medicalInsuranceCardReceivedDate: string | null;
  socialInsuranceStartDate: string | null;
  kaabElamaalNumber: string | null;
  kaabElamaalIssuer: string | null;
  kaabElamaalIssueDate: string | null;
  kaabElamaalRefund: string | null;
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

/**
 * The dry run as the browser receives it: the plan, plus the one "before" value the page cannot
 * work out for itself.
 *
 * WHY IT IS NOT PART OF THE PLAN. `createEmployeeImportPlan` is pure — it reads the uploaded rows
 * and the existing state it is handed, and nothing else. The insurance job title lives in
 * `employee_hiring_profile`, which the employee directory the page already holds does not carry,
 * so the ROUTE fetches it and hangs it off the answer. Keeping it in its own type is what stops a
 * transport concern leaking into the planner's contract.
 *
 * OPTIONAL, and its absence is meaningful: the change preview shows the insurance title row only
 * when this is present. Without it the "before" side is unknown, and rendering unknown as blank
 * would report every filled cell as a change from nothing.
 */
export type EmployeeImportDryRunResponse = EmployeeImportValidationResult & {
  /** HR id (lower-cased) -> the title on file, or null when the employee has no profile row. */
  socialInsuranceJobTitles?: Record<string, string | null>;
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
  /**
   * Canonical HR_ID key (hr-id.ts's alias-resolved, lowercased key) -> the exact hr_id value
   * actually stored in employees.hr_id. Lets the validator rewrite an uploaded alias spelling
   * (e.g. legacy "AAA") to the real stored value (e.g. "AA") BEFORE routing/writing, so the
   * confirm route's upsert conflict-matches the existing row instead of duplicating it.
   */
  employeeHrIdByCanonicalKey?: Map<string, { hrId: string }>;
  /**
   * Normalized full name -> the hr_id(s) already carrying it. Backs the nickname guard: an
   * uploaded nickname that is really a DIFFERENT employee's name is refused rather than written.
   * A name is NOT unique here (two people genuinely share one), so the value is a list.
   */
  employeeHrIdsByFullNameKey?: Map<string, string[]>;
  /**
   * Canonical HR_ID key -> that employee's STORED nickname, normalized with personNameKey. Backs the
   * nickname guard's one exception: re-importing the nickname an employee already carries renames
   * nobody, so it is reported as a warning instead of refusing the whole row.
   */
  employeeNicknameKeyByCanonicalKey?: Map<string, string>;
  /**
   * Canonical HR_ID key -> that employee's STORED payment mode and payroll eligibility, derived as
   * the directory derives them. Backs the salary-blind seat's rule that she never changes either
   * (src/lib/employees/salary-blind-pay-flags.ts): her cell is compared with this, an equal one is
   * ignored and a differing one blocks the row. Absent when the read failed — then her two columns
   * are ignored unchecked (and still never written), with one file-level warning saying so.
   */
  storedPayFlagsByCanonicalKey?: Map<string, StoredPayFlags>;
  managerHrIds?: Set<string>;
  terminalEmployeeHrIds?: Set<string>;
  protectedLifecycleHrIds?: Set<string>;
  departmentCodes?: Set<string>;
  departmentCodeToName?: Map<string, string>;
  departmentNameToCode?: Map<string, string>;
  lineCodes?: Set<string>;
  areaCodes?: Set<string>;
  /** The fixed 42 canonical areas (au model). Import maps sales-line areas to these or rejects. */
  canonicalAreas?: Array<{ code: string; name: string }>;
  /**
   * au (line, area) -> region crosswalk. When present, the validator derives each employee row's
   * region (code + precise name) from their resolved (line, area) instead of trusting the
   * drift-prone free-text Region column. Absent -> region derivation is skipped (region_name kept).
   */
  regionCrosswalk?: RegionCrosswalk;
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
  /**
   * The importer never sees a salary (isSalaryBlindRole — the HR Operations Specialist). The plan
   * then carries no money figure at all: a filled money cell blocks its row, every compensation
   * amount on a planned row is null, and the position-policy salary step is skipped, so nothing is
   * computed, reported or written. Payment mode and payroll eligible are never changed by her: a
   * cell that differs from `existingState.storedPayFlagsByCanonicalKey` blocks its row, and both are
   * blanked on every planned row so neither is written. Set by the SERVER from the access context,
   * never from the request. See employee-import-salary-blind.ts.
   */
  salaryBlind?: boolean;
  /**
   * False when the importer lacks `employees:create`: every employee row whose Employee ID is not in
   * `existingState.employeeHrIds`, and every vacant-position row, is refused instead of creating
   * anyone. Omitted or true keeps today's behaviour (an unknown Employee ID becomes a new employee).
   */
  allowNewEmployees?: boolean;
};
