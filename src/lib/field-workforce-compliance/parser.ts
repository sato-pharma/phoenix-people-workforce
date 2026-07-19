import type {
  FieldWorkforceDateColumn,
  FieldWorkforceIgnoredColumn,
  FieldWorkforceParsedEmployeeRow,
  FieldWorkforceParsedWorkbook,
  FieldWorkforceSourceCellValue,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";

type HeaderColumns = {
  employeeName: number;
  hiringDate: number;
  hrId: number;
  month: number | null;
  year: number | null;
};

type ParsedHeaderDate = {
  dateIso: string | null;
  dayNumber: number | null;
  month: number | null;
  year: number | null;
};

const monthNames = new Map([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

const monthLabels = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedHeader(value: unknown) {
  return text(value).toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function cellValue(value: unknown): FieldWorkforceSourceCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" || typeof value === "boolean") return value;
  const compact = text(value);
  return compact ? compact : null;
}

function isBlank(value: unknown) {
  return text(value).length === 0;
}

function toFourDigitYear(value: number) {
  if (value >= 0 && value < 100) return 2000 + value;
  return value;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toDateIso(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function parseMonthValue(value: unknown): number | null {
  if (value instanceof Date) return value.getUTCMonth() + 1;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12) return value;
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) {
    const month = Number(raw);
    return month >= 1 && month <= 12 ? month : null;
  }
  return monthNames.get(raw.slice(0, 3)) ?? monthNames.get(raw) ?? null;
}

export function parseYearValue(value: unknown): number | null {
  if (value instanceof Date) return value.getUTCFullYear();
  if (typeof value === "number" && Number.isInteger(value)) {
    const year = toFourDigitYear(value);
    return year >= 2000 && year <= 2100 ? year : null;
  }
  const match = text(value).match(/\b(\d{2}|\d{4})\b/);
  if (!match) return null;
  const year = toFourDigitYear(Number(match[1]));
  return year >= 2000 && year <= 2100 ? year : null;
}

function dateFromExcelSerial(value: number) {
  if (!Number.isFinite(value) || value < 1 || value > 100000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(value) * 86400000);
  return date.toISOString().slice(0, 10);
}

export function parseDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return toDateIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number") return dateFromExcelSerial(value);

  const raw = text(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return toDateIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dayMonthYear = raw.match(/^(\d{1,2})[\s/-]+([A-Za-z]+)[\s/-]+(\d{2}|\d{4})$/);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = parseMonthValue(dayMonthYear[2]);
    const year = toFourDigitYear(Number(dayMonthYear[3]));
    return month ? toDateIso(year, month, day) : null;
  }

  const monthDayYear = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/);
  if (monthDayYear) {
    const month = parseMonthValue(monthDayYear[1]);
    const day = Number(monthDayYear[2]);
    const year = toFourDigitYear(Number(monthDayYear[3]));
    return month ? toDateIso(year, month, day) : null;
  }

  return null;
}

function parseHeaderDate(value: unknown, fallbackYear: number | null): ParsedHeaderDate {
  if (value instanceof Date) {
    return {
      dateIso: toDateIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()),
      dayNumber: value.getUTCDate(),
      month: value.getUTCMonth() + 1,
      year: value.getUTCFullYear(),
    };
  }
  if (typeof value === "number") {
    const dateIso = dateFromExcelSerial(value);
    if (!dateIso) return { dateIso: null, dayNumber: null, month: null, year: null };
    const date = new Date(`${dateIso}T00:00:00Z`);
    return {
      dateIso,
      dayNumber: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    };
  }

  const raw = text(value);
  if (!raw) return { dateIso: null, dayNumber: null, month: null, year: null };

  const dayMonthYear = raw.match(/^(\d{1,2})[\s/-]+([A-Za-z]+)[\s/-]+(\d{2}|\d{4})$/);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = parseMonthValue(dayMonthYear[2]);
    const year = toFourDigitYear(Number(dayMonthYear[3]));
    return {
      dateIso: month ? toDateIso(year, month, day) : null,
      dayNumber: day,
      month,
      year,
    };
  }

  const dayMonth = raw.match(/^(\d{1,2})[\s/-]+([A-Za-z]+)$/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = parseMonthValue(dayMonth[2]);
    const year = fallbackYear;
    return {
      dateIso: month && year ? toDateIso(year, month, day) : null,
      dayNumber: day,
      month,
      year,
    };
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return {
      dateIso: toDateIso(year, month, day),
      dayNumber: day,
      month,
      year,
    };
  }

  return { dateIso: null, dayNumber: null, month: null, year: null };
}

function headerColumn(headers: unknown[], aliases: string[]) {
  const normalizedAliases = new Set(aliases.map(normalizedHeader));
  return headers.findIndex((header) => normalizedAliases.has(normalizedHeader(header)));
}

function detectHeaderColumns(headers: unknown[]): HeaderColumns | null {
  const employeeName = headerColumn(headers, ["tm", "employee", "employee name", "name"]);
  const hrId = headerColumn(headers, ["hr id", "hr_id", "code", "employee code", "employee id"]);
  const hiringDate = headerColumn(headers, ["hiring date", "hire date", "joining date"]);
  const month = headerColumn(headers, ["month"]);
  const year = headerColumn(headers, ["year"]);

  if (employeeName < 0 || hrId < 0 || hiringDate < 0) return null;

  return {
    employeeName,
    hiringDate,
    hrId,
    month: month >= 0 ? month : null,
    year: year >= 0 ? year : null,
  };
}

function nonEmptyRowsAfter(matrix: unknown[][], rowIndex: number) {
  return matrix.slice(rowIndex + 1).filter((row) => row.some((cell) => !isBlank(cell)));
}

function detectMonthYear(matrix: unknown[][], headerRowIndex: number, columns: HeaderColumns) {
  const monthValues = new Set<number>();
  const yearValues = new Set<number>();

  for (const row of nonEmptyRowsAfter(matrix, headerRowIndex)) {
    if (columns.month !== null) {
      const month = parseMonthValue(row[columns.month]);
      if (month) monthValues.add(month);
    }
    if (columns.year !== null) {
      const year = parseYearValue(row[columns.year]);
      if (year) yearValues.add(year);
    }
  }

  return {
    month: monthValues.size === 1 ? [...monthValues][0] : null,
    monthValues,
    year: yearValues.size === 1 ? [...yearValues][0] : null,
    yearValues,
  };
}

function buildDateColumns(input: {
  columns: HeaderColumns;
  headers: unknown[];
  month: number | null;
  warnings: FieldWorkforceValidationIssue[];
  year: number | null;
}) {
  const staticIndexes = new Set([
    input.columns.employeeName,
    input.columns.hrId,
    input.columns.hiringDate,
    input.columns.month,
    input.columns.year,
  ].filter((index): index is number => typeof index === "number"));
  const dateColumns: FieldWorkforceDateColumn[] = [];
  const ignoredColumns: FieldWorkforceIgnoredColumn[] = [];

  input.headers.forEach((header, columnIndex) => {
    if (staticIndexes.has(columnIndex)) return;
    const parsed = parseHeaderDate(header, input.year);
    const headerText = text(header);

    if (parsed.dateIso && parsed.month === input.month && parsed.year === input.year && parsed.dayNumber) {
      dateColumns.push({
        columnIndex,
        dateIso: parsed.dateIso,
        dayNumber: parsed.dayNumber,
        header: headerText,
      });
      return;
    }

    if (
      input.month &&
      input.year &&
      parsed.month === input.month &&
      parsed.year === input.year &&
      parsed.dayNumber &&
      parsed.dayNumber > daysInMonth(input.year, input.month)
    ) {
      ignoredColumns.push({
        columnIndex,
        dayNumber: parsed.dayNumber,
        header: headerText,
        reason: "after_month_end",
      });
      return;
    }

    if (parsed.dateIso && input.month && input.year) {
      input.warnings.push({
        code: "date_header_outside_month",
        field: headerText,
        message: `Date header "${headerText}" is outside the detected month and was ignored.`,
        severity: "warning",
      });
    }
  });

  dateColumns.sort((left, right) => left.dateIso.localeCompare(right.dateIso));
  return { dateColumns, ignoredColumns };
}

function duplicateHrIdIssues(rows: FieldWorkforceParsedEmployeeRow[]) {
  const seen = new Map<string, number>();
  const issues: FieldWorkforceValidationIssue[] = [];
  for (const row of rows) {
    const key = row.hrId.trim().toLowerCase();
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) {
      issues.push({
        code: "duplicate_hr_id",
        field: row.hrId,
        message: `HR ID ${row.hrId} appears more than once in this upload.`,
        rowNumber: row.sourceRowNumber,
        severity: "error",
      });
    } else {
      seen.set(key, row.sourceRowNumber);
    }
  }
  return issues;
}

export function parseFieldWorkforceComplianceMatrix(input: {
  fileName: string;
  matrix: unknown[][];
  sheetName: string;
}): FieldWorkforceParsedWorkbook {
  const warnings: FieldWorkforceValidationIssue[] = [];
  const errors: FieldWorkforceValidationIssue[] = [];
  let headerRowIndex = -1;
  let columns: HeaderColumns | null = null;

  for (let rowIndex = 0; rowIndex < Math.min(input.matrix.length, 10); rowIndex += 1) {
    const detected = detectHeaderColumns(input.matrix[rowIndex] ?? []);
    if (detected) {
      headerRowIndex = rowIndex;
      columns = detected;
      break;
    }
  }

  if (!columns || headerRowIndex < 0) {
    errors.push({
      code: "missing_required_columns",
      message: "Required columns were not found. Expected employee name, HR ID/code, and hiring date columns.",
      severity: "error",
    });
    return {
      dateColumns: [],
      errors,
      fileName: input.fileName,
      headerRowNumber: 0,
      ignoredColumns: [],
      month: null,
      monthLabel: null,
      rows: [],
      sheetName: input.sheetName,
      warnings,
      year: null,
    };
  }

  const detected = detectMonthYear(input.matrix, headerRowIndex, columns);
  let month = detected.month;
  let year = detected.year;

  if (columns.month !== null && detected.monthValues.size > 1) {
    errors.push({
      code: "mixed_month_values",
      message: "The Month column contains more than one month.",
      severity: "error",
    });
  }
  if (columns.year !== null && detected.yearValues.size > 1) {
    errors.push({
      code: "mixed_year_values",
      message: "The Year column contains more than one year.",
      severity: "error",
    });
  }

  const headers = input.matrix[headerRowIndex] ?? [];
  if (!year) {
    const parsedYears = headers
      .map((header) => parseHeaderDate(header, null).year)
      .filter((value): value is number => typeof value === "number");
    const uniqueYears = new Set(parsedYears);
    if (uniqueYears.size === 1) year = [...uniqueYears][0];
  }
  if (!month) {
    const parsedMonths = headers
      .map((header) => parseHeaderDate(header, year).month)
      .filter((value): value is number => typeof value === "number");
    const uniqueMonths = new Set(parsedMonths);
    if (uniqueMonths.size === 1) month = [...uniqueMonths][0];
  }

  if (!month || !year) {
    errors.push({
      code: "missing_month_year",
      message: "The upload month and year could not be detected.",
      severity: "error",
    });
  }

  const { dateColumns, ignoredColumns } = buildDateColumns({
    columns,
    headers,
    month,
    warnings,
    year,
  });

  if (dateColumns.length === 0) {
    errors.push({
      code: "missing_date_columns",
      message: "No usable daily date columns were detected.",
      severity: "error",
    });
  }

  if (month && year) {
    const daySet = new Set(dateColumns.map((column) => column.dayNumber));
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
      if (!daySet.has(day)) {
        warnings.push({
          code: "missing_day_column",
          field: String(day),
          message: `Day ${day} is missing from the detected month timeline and will appear as blank in preview.`,
          severity: "warning",
        });
      }
    }
  }

  const rows: FieldWorkforceParsedEmployeeRow[] = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < input.matrix.length; rowIndex += 1) {
    const row = input.matrix[rowIndex] ?? [];
    if (row.every(isBlank)) continue;

    const employeeName = text(row[columns.employeeName]);
    const hrId = text(row[columns.hrId]);
    const rawHiringDate = cellValue(row[columns.hiringDate]);
    const hiringDateIso = parseDateValue(row[columns.hiringDate]);

    if (!employeeName && !hrId) continue;
    if (!hrId) {
      warnings.push({
        code: "missing_hr_id",
        message: "A row has no HR ID/code and cannot be matched to Phoenix employees.",
        rowNumber: rowIndex + 1,
        severity: "warning",
      });
    }
    if (!hiringDateIso) {
      warnings.push({
        code: "invalid_hiring_date",
        field: text(row[columns.hiringDate]),
        message: `Hiring date could not be parsed for ${employeeName || hrId || `row ${rowIndex + 1}`}.`,
        rowNumber: rowIndex + 1,
        severity: "warning",
      });
    }

    const rawDailyValues = Object.fromEntries(
      dateColumns.map((column) => [
        column.dateIso,
        cellValue(row[column.columnIndex]),
      ]),
    );

    for (const ignoredColumn of ignoredColumns) {
      const value = cellValue(row[ignoredColumn.columnIndex]);
      if (value !== null) {
        warnings.push({
          code: "after_month_end_value_ignored",
          field: ignoredColumn.header,
          message: `A value after month end was ignored for ${employeeName || hrId || `row ${rowIndex + 1}`}.`,
          rowNumber: rowIndex + 1,
          severity: "warning",
        });
      }
    }

    rows.push({
      employeeName,
      hiringDateIso,
      hrId,
      monthLabel: columns.month === null ? null : text(row[columns.month]),
      rawDailyValues,
      rawHiringDate,
      sourceRowNumber: rowIndex + 1,
      year: columns.year === null ? null : parseYearValue(row[columns.year]),
    });
  }

  if (rows.length === 0) {
    errors.push({
      code: "empty_employee_rows",
      message: "No employee rows were found in the detected worksheet.",
      severity: "error",
    });
  }

  errors.push(...duplicateHrIdIssues(rows));

  return {
    dateColumns,
    errors,
    fileName: input.fileName,
    headerRowNumber: headerRowIndex + 1,
    ignoredColumns,
    month,
    monthLabel: month ? monthLabels[month - 1] : null,
    rows,
    sheetName: input.sheetName,
    warnings,
    year,
  };
}

// parseFieldWorkforceComplianceWorksheet / findUsableFieldWorkforceWorksheet (the ExcelJS-workbook
// entry points) were removed with the FWC Excel import. parseFieldWorkforceComplianceMatrix above
// stays — the live path feeds it an in-memory matrix built from the CRM visits mirror.
