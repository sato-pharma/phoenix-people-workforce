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
  OrganizationEntityToCreate,
  RawEmployeeImportRow,
} from "@/lib/imports/employee-import-types";
import {
  createScopedCode,
  normalizeDateValue,
  normalizeEmail,
  normalizeHeaderName,
  normalizeHrId,
  normalizeTextValue,
} from "@/lib/imports/employee-normalizers";

type HeaderMapping = Map<EmployeeImportField, string>;

const fieldPriority: EmployeeImportField[] = [
  "hrId",
  "crmId",
  "fullName",
  "nameAr",
  "workEmail",
  "mobileNumber",
  "jobTitle",
  "hireDate",
  "education",
  "managerHrId",
  "department",
  "line",
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
): EmployeeImportRecord {
  const departmentName = normalizeTextValue(valueFor(row, mapping, "department"));
  const lineName = normalizeTextValue(valueFor(row, mapping, "line"));
  const areaName = normalizeTextValue(valueFor(row, mapping, "area"));
  const teamName = normalizeTextValue(valueFor(row, mapping, "team"));
  const jobTitle = normalizeTextValue(valueFor(row, mapping, "jobTitle"));
  const positionTitle =
    normalizeTextValue(valueFor(row, mapping, "position")) ?? jobTitle;

  const departmentCode = createScopedCode(departmentName);
  const lineCode = createScopedCode(departmentCode, lineName);
  const areaCode = createScopedCode(lineCode, areaName);
  const teamCode = createScopedCode(areaCode, teamName);
  const positionCode = createScopedCode(departmentCode, positionTitle);

  return {
    rowNumber,
    source: row,
    hrId: normalizeHrId(valueFor(row, mapping, "hrId")),
    crmId: normalizeTextValue(valueFor(row, mapping, "crmId")),
    fullName: normalizeTextValue(valueFor(row, mapping, "fullName")),
    nameAr: normalizeTextValue(valueFor(row, mapping, "nameAr")),
    workEmail: normalizeEmail(valueFor(row, mapping, "workEmail")),
    mobileNumber: normalizeTextValue(valueFor(row, mapping, "mobileNumber")),
    jobTitle,
    hireDate: normalizeDateValue(valueFor(row, mapping, "hireDate")),
    education: normalizeTextValue(valueFor(row, mapping, "education")),
    managerHrId: normalizeHrId(valueFor(row, mapping, "managerHrId")),
    departmentName,
    lineName,
    areaName,
    teamName,
    positionTitle,
    codes: {
      departmentCode,
      lineCode,
      areaCode,
      teamCode,
      positionCode,
    },
  };
}

function collectOrganizationEntities(
  records: EmployeeImportRecord[],
  options: EmployeeImportPlanOptions,
) {
  const existing = options.existingState;
  const entities = new Map<string, OrganizationEntityToCreate>();

  function addEntity(entity: OrganizationEntityToCreate, exists?: Set<string>) {
    if (exists?.has(entity.code)) {
      return;
    }

    entities.set(`${entity.type}:${entity.code}`, entity);
  }

  for (const record of records) {
    if (record.departmentName && record.codes.departmentCode) {
      addEntity(
        {
          type: "department",
          code: record.codes.departmentCode,
          name: record.departmentName,
        },
        existing?.departmentCodes,
      );
    }

    if (record.lineName && record.codes.lineCode) {
      addEntity(
        {
          type: "line",
          code: record.codes.lineCode,
          name: record.lineName,
          parentCode: record.codes.departmentCode ?? undefined,
        },
        existing?.lineCodes,
      );
    }

    if (record.areaName && record.codes.areaCode) {
      addEntity(
        {
          type: "area",
          code: record.codes.areaCode,
          name: record.areaName,
          parentCode: record.codes.lineCode ?? undefined,
        },
        existing?.areaCodes,
      );
    }

    if (record.teamName && record.codes.teamCode) {
      addEntity(
        {
          type: "team",
          code: record.codes.teamCode,
          name: record.teamName,
          parentCode: record.codes.areaCode ?? undefined,
        },
        existing?.teamCodes,
      );
    }

    if (record.positionTitle && record.codes.positionCode) {
      addEntity(
        {
          type: "position",
          code: record.codes.positionCode,
          name: record.positionTitle,
          parentCode: record.codes.departmentCode ?? undefined,
        },
        existing?.positionCodes,
      );
    }
  }

  return Array.from(entities.values());
}

function sortFields(fields: EmployeeImportField[]) {
  return [...fields].sort(
    (left, right) => fieldPriority.indexOf(left) - fieldPriority.indexOf(right),
  );
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
  const records = rows.map((row, index) =>
    buildRecord(row, firstDataRowNumber + index, mapping),
  );

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
    if (!record.hrId) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "hrId",
        code: "missing_hr_id",
        message: "Employee row is missing HR_ID.",
      });
    } else {
      hrIdCounts.set(record.hrId, (hrIdCounts.get(record.hrId) ?? 0) + 1);
    }

    if (!record.fullName) {
      validationErrors.push({
        rowNumber: record.rowNumber,
        field: "fullName",
        code: "missing_full_name",
        message: "Employee row is missing full name.",
      });
    }
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

  const fileHrIds = new Set(records.flatMap((record) => (record.hrId ? [record.hrId] : [])));
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

  return {
    totalRows: rows.length,
    validRows: importableRecords.filter(
      (record) => !warningRowNumbers.has(record.rowNumber),
    ).length,
    warningRows: Array.from(warningRowNumbers).filter(
      (rowNumber) => !failedRowNumbers.has(rowNumber),
    ).length,
    failedRows: failedRowNumbers.size,
    detectedColumns,
    missingRequiredColumns,
    duplicateHrIds,
    rowsToInsert: importableRecords.filter(
      (record) => record.hrId && !existingEmployeeHrIds.has(record.hrId),
    ),
    rowsToUpdate: importableRecords.filter(
      (record) => record.hrId && existingEmployeeHrIds.has(record.hrId),
    ),
    organizationEntitiesToCreate: collectOrganizationEntities(
      importableRecords,
      options,
    ),
    validationErrors,
    validationWarnings,
  };
}
