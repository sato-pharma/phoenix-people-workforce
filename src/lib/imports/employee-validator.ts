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
import { calculateGrossSalary } from "@/lib/payroll/policy";

type HeaderMapping = Map<EmployeeImportField, string>;
const salaryFormulaTolerance = 1;

const fieldPriority: EmployeeImportField[] = [
  "hrId",
  "crmId",
  "crmUsername",
  "fullName",
  "nameAr",
  "workEmail",
  "mobileNumber",
  "jobTitle",
  "hireDate",
  "birthDate",
  "education",
  "managerHrId",
  "managerName",
  "netSalary",
  "socialInsurance",
  "taxes",
  "medicalInsurance",
  "comprehensiveWage",
  "subscriptionWage",
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
];

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
    workEmail: normalizeEmail(valueFor(row, mapping, "workEmail")),
    mobileNumber: normalizeTextValue(valueFor(row, mapping, "mobileNumber")),
    jobTitle,
    hireDate: normalizeDateValue(valueFor(row, mapping, "hireDate")),
    birthDate: normalizeDateValue(valueFor(row, mapping, "birthDate")),
    education: normalizeTextValue(valueFor(row, mapping, "education")),
    managerHrId: normalizeHrId(valueFor(row, mapping, "managerHrId")),
    managerName: normalizeTextValue(valueFor(row, mapping, "managerName")),
    compensation: {
      comprehensiveWage: normalizeNumberValue(
        valueFor(row, mapping, "comprehensiveWage"),
      ),
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
      paymentMode: normalizeTextValue(valueFor(row, mapping, "paymentMode")),
      socialInsurance: normalizeNumberValue(
        valueFor(row, mapping, "socialInsurance"),
      ),
      subscriptionWage: normalizeNumberValue(
        valueFor(row, mapping, "subscriptionWage"),
      ),
      taxes: normalizeNumberValue(valueFor(row, mapping, "taxes")),
    },
    departmentName: organization.department.displayName,
    lineName: organization.line.displayName,
    regionName: normalizeTextValue(valueFor(row, mapping, "region")),
    areaName: organization.area.displayName,
    teamName: organization.team.displayName,
    positionTitle: organization.position.displayName,
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
    if (record.departmentName && record.codes.departmentCode) {
      addEntity(
        {
          type: "department",
          code: record.codes.departmentCode,
          name: record.departmentName,
          normalizedName:
            record.normalizedOrganizationNames.department ??
            record.codes.departmentCode,
          rawValuesMerged: [],
        },
        record.rawOrganizationValues.department,
        existing?.departmentCodes,
      );
    }

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

    if (record.rowType === "employee") {
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

  const duplicateHrIdSet = new Set(duplicateHrIds);

  for (const record of records) {
    if (record.hrId && duplicateHrIdSet.has(record.hrId)) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "duplicate_hr_id",
        message: `Duplicate HR_ID detected: ${record.hrId}.`,
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
      validationWarnings.push({
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
