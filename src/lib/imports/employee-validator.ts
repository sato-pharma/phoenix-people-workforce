import {
  createEmployeeColumnLookup,
  requiredEmployeeImportFields,
} from "@/lib/imports/employee-column-map";
import type {
  DetectedEmployeeColumn,
  EmployeeImportField,
  EmployeeImportIssue,
  EmployeeImportPlanOptions,
  EmployeeImportRecord,
  EmployeeImportValidationResult,
  OrganizationEntityCounts,
  OrganizationEntitiesToCreate,
  OrganizationEntityToCreate,
  RawEmployeeImportRow,
  VacantPositionImportRecord,
} from "@/lib/imports/employee-import-types";
import {
  isVacancyPlaceholderHrId,
  isValidHrId,
  normalizeDateValue,
  normalizeEmail,
  normalizeHeaderName,
  normalizeHrId,
  normalizeNumberValue,
  normalizeTextValue,
} from "@/lib/imports/employee-normalizers";
import {
  classifyOrganizationRow,
  createOrgCode,
  type OrgMappingSample,
  type OrgMappingWarning,
} from "@/lib/imports/org-rule-engine";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { calculateGrossSalary } from "@/lib/payroll/policy";

type HeaderMapping = Map<EmployeeImportField, string>;
const salaryFormulaTolerance = 1;

const fieldPriority: EmployeeImportField[] = [
  "hrId",
  "crmId",
  "crmUsername",
  "fullName",
  "nameAr",
  "nationalId",
  "gender",
  "workEmail",
  "mobileNumber",
  "jobTitle",
  "hireDate",
  "birthDate",
  "education",
  "employmentStatus",
  "payrollEligible",
  "organogramVisible",
  "managerHrId",
  "managerName",
  "contractType",
  "hasBankAccount",
  "bankName",
  "bankAccount",
  "socialInsuranceStatus",
  "socialInsuranceNumber",
  "medicalInsuranceStatus",
  "medicalInsuranceNumber",
  "basicSalary",
  "baseSalary",
  "netSalary",
  "socialInsurance",
  "taxes",
  "medicalInsurance",
  "fuelAllowance",
  "extraCostOfLiving",
  "grossSalary",
  "paymentMode",
  "department",
  "line",
  "region",
  "area",
  "team",
  "position",
  "residenceAddress",
  "residenceCity",
  "residenceArea",
];

const activeImportStatuses = new Set(["", "active", "on_leave"]);
const genderValues = new Set(["male", "female", "other", "not specified", "prefer not to say"]);
const contractValues = new Set(["permanent", "fixed-term", "fixed term", "temporary", "consultant", "internship", "not specified"]);
const paymentModeValues = new Set(["two_parts", "one_part", "two parts", "one part"]);
const yesNoValues = new Set(["yes", "no"]);
const enrollmentStatusValues = new Set(["yes", "no", "pending"]);
const numericImportFields: EmployeeImportField[] = [
  "basicSalary",
  "baseSalary",
  "netSalary",
  "socialInsurance",
  "taxes",
  "medicalInsurance",
  "fuelAllowance",
  "extraCostOfLiving",
  "grossSalary",
];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function detectColumns(rows: RawEmployeeImportRow[]) {
  const columnLookup = createEmployeeColumnLookup();
  const mapping: HeaderMapping = new Map();
  const detectedColumns: DetectedEmployeeColumn[] = [];
  const headers = new Set<string>();

  for (const row of rows) {
    for (const header of Object.keys(row)) {
      headers.add(header);
    }
  }

  for (const header of headers) {
    const normalizedHeader = normalizeHeaderName(header);
    const field = columnLookup.get(normalizedHeader);

    if (!field || mapping.has(field)) {
      continue;
    }

    mapping.set(field, header);
    detectedColumns.push({ field, sourceHeader: header, normalizedHeader });
  }

  return { mapping, detectedColumns };
}

function valueFor(
  row: RawEmployeeImportRow,
  mapping: HeaderMapping,
  field: EmployeeImportField,
) {
  const header = mapping.get(field);
  return header ? row[header] : null;
}

function buildRecord(
  row: RawEmployeeImportRow,
  rowNumber: number,
  mapping: HeaderMapping,
): {
  record: EmployeeImportRecord;
  orgMappingWarnings: OrgMappingWarning[];
  sampleOrgMapping: OrgMappingSample;
} {
  const jobTitle = normalizeTextValue(valueFor(row, mapping, "jobTitle"));
  const organization = classifyOrganizationRow({
    rowNumber,
    department: valueFor(row, mapping, "department"),
    line: valueFor(row, mapping, "line"),
    area: valueFor(row, mapping, "area"),
    team: valueFor(row, mapping, "team"),
    position: normalizeTextValue(valueFor(row, mapping, "position")) ?? jobTitle,
  });

  const departmentCode = createOrgCode(organization.department.normalizedName);
  const lineCode = createOrgCode(organization.line.normalizedName);
  const areaCode = createOrgCode(organization.area.normalizedName);
  const teamCode = createOrgCode(organization.team.normalizedName);
  const positionCode = createOrgCode(organization.position.normalizedName);
  const hrId = normalizeHrId(valueFor(row, mapping, "hrId"));
  const rowType =
    !hrId || isVacancyPlaceholderHrId(hrId) ? "vacant_position" : "employee";

  const record: EmployeeImportRecord = {
    rowNumber,
    rowType,
    source: row,
    hrId,
    crmId: normalizeTextValue(valueFor(row, mapping, "crmId")),
    crmUsername: normalizeTextValue(valueFor(row, mapping, "crmUsername")),
    fullName: normalizeTextValue(valueFor(row, mapping, "fullName")),
    nameAr: normalizeTextValue(valueFor(row, mapping, "nameAr")),
    nationalId: normalizeTextValue(valueFor(row, mapping, "nationalId")),
    gender: normalizeTextValue(valueFor(row, mapping, "gender"))?.toLowerCase() ?? null,
    workEmail: normalizeEmail(valueFor(row, mapping, "workEmail")),
    mobileNumber: normalizeTextValue(valueFor(row, mapping, "mobileNumber")),
    jobTitle,
    hireDate: normalizeDateValue(valueFor(row, mapping, "hireDate")),
    birthDate: normalizeDateValue(valueFor(row, mapping, "birthDate")),
    education: normalizeTextValue(valueFor(row, mapping, "education")),
    employmentStatus: normalizeTextValue(valueFor(row, mapping, "employmentStatus"))?.toLowerCase() ?? null,
    payrollEligible: normalizeTextValue(valueFor(row, mapping, "payrollEligible")),
    organogramVisible: normalizeTextValue(valueFor(row, mapping, "organogramVisible")),
    managerHrId: normalizeHrId(valueFor(row, mapping, "managerHrId")),
    managerName: normalizeTextValue(valueFor(row, mapping, "managerName")),
    contractType: normalizeTextValue(valueFor(row, mapping, "contractType"))?.toLowerCase() ?? null,
    hasBankAccount: normalizeTextValue(valueFor(row, mapping, "hasBankAccount"))?.toLowerCase() ?? null,
    bankName: normalizeTextValue(valueFor(row, mapping, "bankName")),
    bankAccount: normalizeTextValue(valueFor(row, mapping, "bankAccount")),
    socialInsuranceStatus: normalizeTextValue(valueFor(row, mapping, "socialInsuranceStatus"))?.toLowerCase() ?? null,
    socialInsuranceNumber: normalizeTextValue(valueFor(row, mapping, "socialInsuranceNumber")),
    medicalInsuranceStatus: normalizeTextValue(valueFor(row, mapping, "medicalInsuranceStatus"))?.toLowerCase() ?? null,
    medicalInsuranceNumber: normalizeTextValue(valueFor(row, mapping, "medicalInsuranceNumber")),
    compensation: {
      basicSalary: normalizeNumberValue(valueFor(row, mapping, "basicSalary")),
      baseSalary: normalizeNumberValue(valueFor(row, mapping, "baseSalary")),
      extraCostOfLiving: normalizeNumberValue(
        valueFor(row, mapping, "extraCostOfLiving"),
      ),
      fuelAllowance: normalizeNumberValue(
        valueFor(row, mapping, "fuelAllowance"),
      ),
      grossSalary: normalizeNumberValue(valueFor(row, mapping, "grossSalary")),
      medicalInsurance: normalizeNumberValue(
        valueFor(row, mapping, "medicalInsurance"),
      ),
      netSalary: normalizeNumberValue(valueFor(row, mapping, "netSalary")),
      paymentMode: normalizeTextValue(valueFor(row, mapping, "paymentMode"))?.toLowerCase() ?? null,
      socialInsurance: normalizeNumberValue(
        valueFor(row, mapping, "socialInsurance"),
      ),
      taxes: normalizeNumberValue(valueFor(row, mapping, "taxes")),
    },
    departmentName: organization.department.displayName,
    lineName: organization.line.displayName,
    regionName: normalizeTextValue(valueFor(row, mapping, "region")),
    areaName: organization.area.displayName,
    teamName: organization.team.displayName,
    positionTitle: organization.position.displayName,
    residenceAddress: normalizeTextValue(valueFor(row, mapping, "residenceAddress")),
    residenceCity: normalizeTextValue(valueFor(row, mapping, "residenceCity")),
    residenceArea: normalizeTextValue(valueFor(row, mapping, "residenceArea")),
    normalizedOrganizationNames: {
      department: organization.department.normalizedName,
      line: organization.line.normalizedName,
      area: organization.area.normalizedName,
      team: organization.team.normalizedName,
      position: organization.position.normalizedName,
    },
    rawOrganizationValues: {
      department: organization.department.rawValue,
      line: organization.line.rawValue,
      area: organization.sourceArea.rawValue,
      team: organization.team.rawValue,
      position: organization.position.rawValue,
    },
    codes: {
      departmentCode,
      lineCode,
      areaCode,
      teamCode,
      positionCode,
    },
  };

  return {
    record,
    orgMappingWarnings: organization.warnings,
    sampleOrgMapping: organization.sample,
  };
}

function collectOrganizationEntities(
  records: EmployeeImportRecord[],
  options: EmployeeImportPlanOptions,
) {
  const existing = options.existingState;
  const entityMaps = {
    areas: new Map<string, OrganizationEntityToCreate>(),
    departments: new Map<string, OrganizationEntityToCreate>(),
    lines: new Map<string, OrganizationEntityToCreate>(),
    positions: new Map<string, OrganizationEntityToCreate>(),
    teams: new Map<string, OrganizationEntityToCreate>(),
  };

  function mapForType(type: OrganizationEntityToCreate["type"]) {
    const mapKeys = {
      area: "areas",
      department: "departments",
      line: "lines",
      position: "positions",
      team: "teams",
    } as const;

    return entityMaps[mapKeys[type]];
  }

  function addEntity(
    entity: OrganizationEntityToCreate,
    rawValue: string | null,
    exists?: Set<string>,
  ) {
    if (exists?.has(entity.code)) {
      return;
    }

    const key = `${entity.type}:${entity.code}`;
    const entities = mapForType(entity.type);
    const existingEntity = entities.get(key);

    if (existingEntity) {
      if (rawValue && !existingEntity.rawValuesMerged.includes(rawValue)) {
        existingEntity.rawValuesMerged.push(rawValue);
      }

      if (!existingEntity.parentCode && entity.parentCode) {
        existingEntity.parentCode = entity.parentCode;
      }

      return;
    }

    entities.set(key, {
      ...entity,
      rawValuesMerged: rawValue ? [rawValue] : [],
    });
  }

  for (const record of records) {
    // Departments are governed global lookup rows. Import may reference them,
    // but must not create new departments from typo values.

    if (record.lineName && record.codes.lineCode) {
      addEntity(
        {
          type: "line",
          code: record.codes.lineCode,
          name: record.lineName,
          normalizedName:
            record.normalizedOrganizationNames.line ?? record.codes.lineCode,
          rawValuesMerged: [],
          parentCode: record.codes.departmentCode ?? undefined,
        },
        record.rawOrganizationValues.line,
        existing?.lineCodes,
      );
    }

    if (record.areaName && record.codes.areaCode) {
      addEntity(
        {
          type: "area",
          code: record.codes.areaCode,
          name: record.areaName,
          normalizedName:
            record.normalizedOrganizationNames.area ?? record.codes.areaCode,
          rawValuesMerged: [],
          parentCode: record.codes.lineCode ?? undefined,
        },
        record.rawOrganizationValues.area,
        existing?.areaCodes,
      );
    }

    if (record.teamName && record.codes.teamCode) {
      addEntity(
        {
          type: "team",
          code: record.codes.teamCode,
          name: record.teamName,
          normalizedName:
            record.normalizedOrganizationNames.team ?? record.codes.teamCode,
          rawValuesMerged: [],
          parentCode: record.codes.areaCode ?? undefined,
        },
        record.rawOrganizationValues.team,
        existing?.teamCodes,
      );
    }

    if (record.positionTitle && record.codes.positionCode) {
      addEntity(
        {
          type: "position",
          code: record.codes.positionCode,
          name: record.positionTitle,
          normalizedName:
            record.normalizedOrganizationNames.position ??
            record.codes.positionCode,
          rawValuesMerged: [],
          parentCode: record.codes.departmentCode ?? undefined,
        },
        record.rawOrganizationValues.position,
        existing?.positionCodes,
      );
    }
  }

  return {
    areas: Array.from(entityMaps.areas.values()),
    departments: Array.from(entityMaps.departments.values()),
    lines: Array.from(entityMaps.lines.values()),
    positions: Array.from(entityMaps.positions.values()),
    teams: Array.from(entityMaps.teams.values()),
  };
}

function countOrganizationEntities(
  entities: OrganizationEntitiesToCreate,
): OrganizationEntityCounts {
  return {
    area: entities.areas.length,
    department: entities.departments.length,
    line: entities.lines.length,
    position: entities.positions.length,
    team: entities.teams.length,
  };
}

function isEmployeeRecord(
  record: EmployeeImportRecord,
): record is EmployeeImportRecord & { rowType: "employee"; hrId: string } {
  return record.rowType === "employee" && Boolean(record.hrId);
}

function isVacantPositionRecord(
  record: EmployeeImportRecord,
): record is VacantPositionImportRecord {
  return record.rowType === "vacant_position";
}

function sortFields(fields: EmployeeImportField[]) {
  return [...fields].sort(
    (left, right) => fieldPriority.indexOf(left) - fieldPriority.indexOf(right),
  );
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function differs(left: number, right: number, tolerance = salaryFormulaTolerance) {
  return Math.abs(money(left) - money(right)) > tolerance;
}

function moneyText(value: number) {
  return money(value).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

function normalizeDepartmentLookupKey(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCrmIdKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function teamAreaKey(name: string, areaCode: string | null) {
  return `${normalizeDepartmentLookupKey(name)}::${areaCode ?? ""}`;
}

function resolveGlobalDepartment(
  record: EmployeeImportRecord,
  options: EmployeeImportPlanOptions,
) {
  const rawDepartment = record.rawOrganizationValues.department ?? record.departmentName;
  const departmentText = normalizeTextValue(rawDepartment);

  if (!departmentText) {
    return null;
  }

  const nameToCode = options.existingState?.departmentNameToCode;
  const codeToName = options.existingState?.departmentCodeToName;
  const code =
    nameToCode?.get(normalizeDepartmentLookupKey(departmentText)) ??
    nameToCode?.get(normalizeDepartmentLookupKey(record.departmentName)) ??
    nameToCode?.get(normalizeDepartmentLookupKey(record.codes.departmentCode));

  if (!code) {
    return {
      rowNumber: record.rowNumber,
      field: "department" as const,
      code: "invalid_department",
      message: `Department "${departmentText}" is not an active global department.`,
    };
  }

  record.codes.departmentCode = code;
  record.departmentName = codeToName?.get(code) ?? record.departmentName;
  record.normalizedOrganizationNames.department = normalizeDepartmentLookupKey(record.departmentName);

  return null;
}

function resolveGlobalTeam(
  record: EmployeeImportRecord,
  options: EmployeeImportPlanOptions,
) {
  const teamText = normalizeTextValue(record.rawOrganizationValues.team ?? record.teamName);

  if (!teamText) {
    return null;
  }

  const existingState = options.existingState;
  const areaCode = record.codes.areaCode;
  const normalizedTeamName = normalizeDepartmentLookupKey(teamText);
  const exactAreaTeam =
    existingState?.teamNameAreaToTeam?.get(teamAreaKey(teamText, areaCode)) ??
    existingState?.teamNameAreaToTeam?.get(teamAreaKey(record.teamName ?? teamText, areaCode));

  if (exactAreaTeam) {
    record.codes.teamCode = exactAreaTeam.code;
    record.teamName = exactAreaTeam.name;
    record.normalizedOrganizationNames.team = normalizeDepartmentLookupKey(exactAreaTeam.name);
    return null;
  }

  const candidates = existingState?.teamNameToTeams?.get(normalizedTeamName) ?? [];
  const unscopedCandidates = candidates.filter((team) => !team.areaCode);

  if (areaCode && unscopedCandidates.length === 1) {
    const team = unscopedCandidates[0];
    record.codes.teamCode = team.code;
    record.teamName = team.name;
    record.normalizedOrganizationNames.team = normalizeDepartmentLookupKey(team.name);
    return null;
  }

  if (!areaCode && candidates.length > 1) {
    return {
      rowNumber: record.rowNumber,
      field: "team" as const,
      code: "ambiguous_team_area",
      message: `Team "${teamText}" exists under multiple areas. Provide Area so the import can map the correct team.`,
    };
  }

  if (candidates.length === 1 && !areaCode) {
    const team = candidates[0];
    record.codes.teamCode = team.code;
    record.teamName = team.name;
    record.normalizedOrganizationNames.team = normalizeDepartmentLookupKey(team.name);
    return null;
  }

  if (candidates.length > 0 && areaCode) {
    return {
      rowNumber: record.rowNumber,
      field: "team" as const,
      code: "invalid_team_area",
      message: `Team "${teamText}" exists under a different area. Use the matching Area or create a distinct team name.`,
    };
  }

  if (areaCode) {
    record.codes.teamCode = createOrgCode(`${areaCode}_${normalizedTeamName}`);
  }

  return null;
}

export function validateEmployeeImportRows(
  rows: RawEmployeeImportRow[],
  options: EmployeeImportPlanOptions = {},
): EmployeeImportValidationResult {
  const { mapping, detectedColumns } = detectColumns(rows);
  const missingRequiredColumns = sortFields(
    requiredEmployeeImportFields.filter((field) => !mapping.has(field)),
  );
  const firstDataRowNumber = options.firstDataRowNumber ?? 2;
  const builtRows = rows.map((row, index) =>
    buildRecord(row, firstDataRowNumber + index, mapping),
  );
  const records = builtRows.map(({ record }) => record);
  const orgMappingWarnings = builtRows.flatMap(
    ({ orgMappingWarnings }) => orgMappingWarnings,
  );
  const sampleOrgMappings = builtRows
    .map(({ sampleOrgMapping }) => sampleOrgMapping)
    .slice(0, 10);

  const validationErrors: EmployeeImportIssue[] = [];
  const validationWarnings: EmployeeImportIssue[] = [];
  const crmIdCounts = new Map<string, number>();
  const hrIdCounts = new Map<string, number>();

  for (const field of missingRequiredColumns) {
    validationErrors.push({
      field,
      code: "missing_required_column",
      message: `Required column is missing for ${field}.`,
    });
  }

  for (const record of records) {
    if (record.rowType === "employee" && !record.hrId) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "missing_hr_id",
        message: "Employee row is missing HR_ID.",
      });
    } else if (record.rowType === "employee" && record.hrId) {
      hrIdCounts.set(record.hrId, (hrIdCounts.get(record.hrId) ?? 0) + 1);
    }

    const crmIdKey = normalizeCrmIdKey(record.crmId);
    if (record.rowType === "employee" && crmIdKey) {
      crmIdCounts.set(crmIdKey, (crmIdCounts.get(crmIdKey) ?? 0) + 1);
    }

    if (record.rowType === "employee" && record.hrId && !isValidHrId(record.hrId)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "invalid_hr_id",
        message: `Invalid HR_ID format: ${record.hrId}.`,
      });
    }

    if (record.rowType === "employee" && !record.fullName) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "fullName",
        code: "missing_full_name",
        message: "Employee row is missing full name.",
      });
    }

    if (record.rowType === "employee" && record.workEmail && !emailPattern.test(record.workEmail)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "workEmail",
        code: "invalid_email",
        message: `Work email is invalid: ${record.workEmail}.`,
      });
    }

    const departmentError = resolveGlobalDepartment(record, options);
    if (departmentError) {
      validationErrors.push(departmentError);
    }

    const teamError = resolveGlobalTeam(record, options);
    if (teamError) {
      validationErrors.push(teamError);
    }

    for (const [field, value] of [
      ["hireDate", record.hireDate],
      ["birthDate", record.birthDate],
    ] as const) {
      if (value && (!datePattern.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime()))) {
        validationErrors.push({
          rowNumber: record.rowNumber,
          field,
          code: "invalid_date",
          message: `${field === "hireDate" ? "Hire date" : "Birth date"} must be a valid YYYY-MM-DD date.`,
        });
      }
    }

    if (record.rowType === "employee" && record.employmentStatus && !activeImportStatuses.has(record.employmentStatus)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "employmentStatus",
        code: "lifecycle_status_import_blocked",
        message: "Employee import cannot set inactive, resigned, or terminated status. Use the lifecycle workflow.",
      });
    }

    if (record.rowType === "employee" && record.managerHrId && record.hrId === record.managerHrId) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "managerHrId",
        code: "self_manager_assignment",
        message: "An employee cannot be assigned as their own manager.",
      });
    }

    for (const field of numericImportFields) {
      const rawNumber = normalizeTextValue(valueFor(record.source, mapping, field));
      const parsedNumber = field === "basicSalary" || field === "baseSalary"
        ? record.compensation[field]
        : record.compensation[field as keyof typeof record.compensation];
      if (rawNumber && parsedNumber === null) {
        validationErrors.push({
          rowNumber: record.rowNumber,
          field,
          code: "invalid_numeric_value",
          message: `${field} must be a valid numeric value.`,
        });
      }
    }

    if (record.gender && !genderValues.has(record.gender)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "gender",
        code: "invalid_gender",
        message: "Gender must be Male, Female, Other, Not specified, or blank.",
      });
    }

    if (record.contractType && !contractValues.has(record.contractType)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "contractType",
        code: "invalid_contract_type",
        message: "Contract Type must be Permanent, Fixed-term, Temporary, Consultant, Internship, Not specified, or blank.",
      });
    }

    if (record.compensation.paymentMode && !paymentModeValues.has(record.compensation.paymentMode)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "paymentMode",
        code: "invalid_payment_mode",
        message: "Payment Mode must be two_parts, one_part, or blank.",
      });
    }

    if (record.hasBankAccount && !yesNoValues.has(record.hasBankAccount)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hasBankAccount",
        code: "invalid_has_bank_account",
        message: "Has Bank Account must be yes, no, or blank.",
      });
    }

    if (record.medicalInsuranceStatus && !enrollmentStatusValues.has(record.medicalInsuranceStatus)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "medicalInsuranceStatus",
        code: "invalid_medical_insurance_status",
        message: "In Medical Insurance must be yes, no, pending, or blank.",
      });
    }

    if (record.socialInsuranceStatus && !enrollmentStatusValues.has(record.socialInsuranceStatus)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "socialInsuranceStatus",
        code: "invalid_social_insurance_status",
        message: "In Social Insurance must be yes, no, pending, or blank.",
      });
    }

    if (record.rowType === "employee") {
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName: record.departmentName,
        jobTitle: record.jobTitle,
        lineName: record.lineName,
        positionTitle: record.positionTitle,
        teamName: record.teamName,
      });

      if (
        record.compensation.extraCostOfLiving !== null &&
        differs(record.compensation.extraCostOfLiving, standardAllowances.extraCostOfLiving)
      ) {
        validationWarnings.push({
          rowNumber: record.rowNumber,
          field: "extraCostOfLiving",
          code: "extra_cost_of_living_policy_mismatch",
          message: `Extra cost of living was normalized to ${moneyText(standardAllowances.extraCostOfLiving)} by position policy.`,
        });
      }

      if (
        record.compensation.fuelAllowance !== null &&
        differs(record.compensation.fuelAllowance, standardAllowances.fuelAllowance)
      ) {
        validationWarnings.push({
          rowNumber: record.rowNumber,
          field: "fuelAllowance",
          code: "fuel_allowance_policy_mismatch",
          message: `Fuel allowance was normalized to ${moneyText(standardAllowances.fuelAllowance)} by payroll policy.`,
        });
      }

      record.compensation.extraCostOfLiving = standardAllowances.extraCostOfLiving;
      record.compensation.fuelAllowance = standardAllowances.fuelAllowance;

      const expectedGrossSalary = calculateGrossSalary({
        baseSalary: record.compensation.netSalary,
        employmentIncomeTax: record.compensation.taxes,
        extraCostOfLiving: record.compensation.extraCostOfLiving,
        fuelAllowance: record.compensation.fuelAllowance,
        grossSalary: record.compensation.grossSalary,
        socialInsurance: record.compensation.socialInsurance,
      });

      if (expectedGrossSalary > 0) {
        if (
          record.compensation.grossSalary !== null &&
          differs(record.compensation.grossSalary, expectedGrossSalary)
        ) {
          validationWarnings.push({
            rowNumber: record.rowNumber,
            field: "grossSalary",
            code: "gross_salary_formula_mismatch",
            message: `Gross salary was normalized to ${moneyText(expectedGrossSalary)} from base salary plus social insurance and income tax.`,
          });
        }

        record.compensation.grossSalary = expectedGrossSalary;
      }
    }
  }

  for (const warning of orgMappingWarnings) {
    validationWarnings.push({
      rowNumber: warning.rowNumber,
      field: warning.field,
      code: warning.code,
      message: warning.message,
    });
  }

  const duplicateHrIds = Array.from(hrIdCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([hrId]) => hrId);
  const duplicateCrmIds = new Set(
    Array.from(crmIdCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([crmId]) => crmId),
  );

  const duplicateHrIdSet = new Set(duplicateHrIds);
  const existingCrmIdToHrId = options.existingState?.crmIdToHrId ?? new Map<string, string>();
  const terminalEmployeeHrIds = options.existingState?.terminalEmployeeHrIds ?? new Set<string>();
  const protectedLifecycleHrIds = options.existingState?.protectedLifecycleHrIds ?? terminalEmployeeHrIds;

  for (const record of records) {
    if (record.hrId && duplicateHrIdSet.has(record.hrId)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "duplicate_hr_id",
        message: `Duplicate HR_ID detected: ${record.hrId}.`,
      });
    }

    if (record.hrId && protectedLifecycleHrIds.has(record.hrId)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "inactive_employee_update_blocked",
        message: `HR_ID ${record.hrId} belongs to an inactive, hidden, resigned, or payroll-ineligible employee and cannot be reactivated by import.`,
      });
    }

    const crmIdKey = normalizeCrmIdKey(record.crmId);
    if (crmIdKey && duplicateCrmIds.has(crmIdKey)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "crmId",
        code: "duplicate_crm_id",
        message: `Duplicate CRM ID detected in uploaded file: ${record.crmId}.`,
      });
    }

    const existingCrmOwner = crmIdKey ? existingCrmIdToHrId.get(crmIdKey) : null;
    if (record.hrId && existingCrmOwner && existingCrmOwner !== record.hrId) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "crmId",
        code: "crm_id_already_assigned",
        message: `CRM ID ${record.crmId} is already assigned to HR_ID ${existingCrmOwner}.`,
      });
    }
  }

  const fileHrIds = new Set(
    records.flatMap((record) =>
      record.rowType === "employee" && record.hrId ? [record.hrId] : [],
    ),
  );
  const databaseManagerHrIds = options.existingState?.managerHrIds ?? new Set<string>();

  for (const record of records) {
    if (
      record.managerHrId &&
      !fileHrIds.has(record.managerHrId) &&
      !databaseManagerHrIds.has(record.managerHrId)
    ) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "managerHrId",
        code: "manager_hr_id_not_found",
        message: `Manager HR_ID ${record.managerHrId} was not found in the file or provided database snapshot.`,
      });
    }
  }

  const failedRowNumbers = new Set(
    validationErrors
      .filter((issue) => issue.rowNumber !== undefined)
      .map((issue) => issue.rowNumber),
  );
  const warningRowNumbers = new Set(
    validationWarnings
      .filter((issue) => issue.rowNumber !== undefined)
      .map((issue) => issue.rowNumber),
  );
  const importableRecords = records.filter(
    (record) =>
      !failedRowNumbers.has(record.rowNumber) &&
      missingRequiredColumns.length === 0,
  );
  const existingEmployeeHrIds = options.existingState?.employeeHrIds ?? new Set<string>();
  const importableEmployeeRecords = importableRecords.filter(isEmployeeRecord);
  const vacantPositionsToCreate =
    importableRecords.filter(isVacantPositionRecord);
  const organizationEntitiesToCreate = collectOrganizationEntities(
    importableRecords,
    options,
  );

  return {
    totalRows: rows.length,
    validRows: importableRecords.filter(
      (record) => !warningRowNumbers.has(record.rowNumber),
    ).length,
    warningRows: Array.from(warningRowNumbers).filter(
      (rowNumber) => !failedRowNumbers.has(rowNumber),
    ).length,
    failedRows: failedRowNumbers.size,
    vacantRows: records.filter(isVacantPositionRecord).length,
    detectedColumns,
    missingRequiredColumns,
    duplicateHrIds,
    rowsToInsert: importableEmployeeRecords.filter(
      (record) => record.hrId && !existingEmployeeHrIds.has(record.hrId),
    ),
    rowsToUpdate: importableEmployeeRecords.filter(
      (record) => record.hrId && existingEmployeeHrIds.has(record.hrId),
    ),
    vacantPositionsToCreate,
    organizationEntitiesToCreate,
    organizationEntityCounts: countOrganizationEntities(
      organizationEntitiesToCreate,
    ),
    orgMappingWarnings,
    sampleOrgMappings,
    validationErrors,
    validationWarnings,
  };
}
