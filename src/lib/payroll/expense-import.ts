import ExcelJS from "exceljs";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import type {
  ExpenseAnalysisResult,
  ExpenseSpecialistSummary,
  ExpenseTripRecord,
} from "@/lib/payroll/types";
import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { roundCurrency } from "@/lib/payroll/money";

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(text(value).replace(/^:/, "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeHeaderKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const expenseHeaderAliases = {
  columnTripId: ["TripID", "Trip ID", "Trip#"],
  columnSpecialist: [
    "Specialist",
    "Employee",
    "Employee Name",
    "Name",
  ],
  columnHrId: [
    "HR_ID",
    "HR ID",
    "Hr ID",
    "hr_id",
    "Column2",
    "Column 2",
    "Employee Code",
    "Employee ID",
    "employee_code",
    "Code",
  ],
  columnDate: [
    "Date",
    "Trip start",
    "Trip Start Date",
    "Start Date",
    "Startdate",
  ],
  columnFrom: ["From", "From Address", "Start Location"],
  columnTo: ["To", "Destination", "Destination Name"],
  columnToDate: ["To Date", "Trip end", "Trip End Date", "End Date"],
  columnKm: ["KM", "Distance", "Distance (km)", "Distance (KM)"],
  columnTravelCost: [
    "Travel Cost",
    "Travel Cost (auto)",
    "Travel",
    "Travel cost",
  ],
  columnMeeting: ["Meeting Amount", "Meeting", "Meeting Amount (EGP)"],
  columnAllowance: ["Allowance"],
  columnExpected: ["Expected", "Expected Amount"],
  columnTotal: ["Total", "Claimed", "Claim"],
  columnStatus: ["Status", "Eligibility", "Recommendation", "Recommendation Status"],
  columnTransportation: [
    "Transportation Type",
    "Transport",
    "Transport Mode",
    "Transported By",
  ],
  columnDescription: ["Description", "Remarks", "Notes", "Comments"],
  columnRequestType: [
    "Request Type",
    "Trip Type",
    "Role",
    "Workload Type",
    "Expense Type",
  ],
  columnHr: ["HR", "HR Notes", "HR Status"],
  columnRecommendation: ["Recommendation", "Manager Recommendation", "HR Recommendation"],
  columnOpen: ["Open", "Open Status"],
  columnAmWorkload: ["AM Workload", "AM Workload (hrs)"],
  columnPmWorkload: ["PM Workload", "PM Workload (hrs)"],
  columnTripType: [
    "Trip Type",
    "Request Type",
    "Type",
    "Travel Stay Type",
    "Expense Type",
  ],
  columnLocation: ["Location", "Destination", "Destination Name"],
  columnComments: ["Comments", "Comment", "Notes"],
};

const expenseHeaderAliasSet = new Set(
  Object.values(expenseHeaderAliases).flat().map((alias) => normalizeHeaderKey(alias)),
);

type ExpenseTemplateDefinition = {
  key: string;
  name: string;
  requiredColumns: Array<keyof typeof expenseHeaderAliases>;
  sheetNames: string[];
};

const expenseTemplateDefinitions: ExpenseTemplateDefinition[] = [
  {
    key: "phoenix-outstation-expenses-v1",
    name: "Phoenix Outstation Expenses",
    requiredColumns: [
      "columnTripId",
      "columnSpecialist",
      "columnDate",
      "columnToDate",
      "columnRequestType",
      "columnTransportation",
      "columnTripType",
      "columnTo",
      "columnTravelCost",
      "columnMeeting",
      "columnAllowance",
      "columnTotal",
      "columnKm",
      "columnAmWorkload",
      "columnPmWorkload",
      "columnStatus",
    ],
    sheetNames: ["outstationexpenses", "outstation expenses"],
  },
];

function detectExpenseTemplate(
  fileName: string,
  sheetName: string,
  columns: string[],
): { key: string; name: string; recognized: boolean } {
  const normalizedSet = new Set(columns.map(normalizeHeaderName));
  const templateFileHint = normalizeHeaderName(fileName);
  const sheetHint = normalizeHeaderName(sheetName);
  const outstationHint = templateFileHint.includes("outstation");
  const historicalUploadHint = templateFileHint.includes("historical") && templateFileHint.includes("expense");

  let bestMatch = {
    recognized: false,
    key: "generic-expenses-v1",
    name: "Generic Outstation Expense Sheet",
    score: -1,
  };

  for (const template of expenseTemplateDefinitions) {
    const sheetMatch = template.sheetNames.some((name) => normalizeHeaderName(name) === sheetHint);
    const requiredMatchCount = template.requiredColumns.filter((column) => {
      const aliases = expenseHeaderAliases[column];
      return aliases.some((alias) => normalizedSet.has(normalizeHeaderName(alias)));
    }).length;
    const score = requiredMatchCount + (sheetMatch ? 2 : 0);

    if (score > bestMatch.score) {
      bestMatch = {
        recognized:
          score >= 13 || (sheetMatch && score >= 11) || (outstationHint && score >= 11) ||
          (historicalUploadHint && score >= 12),
        key: template.key,
        name: template.name,
        score,
      };
    }
  }

  if (!bestMatch.recognized) {
    return {
      key: "generic-expenses-v1",
      name: "Generic Outstation Expense Sheet",
      recognized: false,
    };
  }

  return {
    key: bestMatch.key,
    name: bestMatch.name,
    recognized: true,
  };
}

function resolveResidenceFromEmployee(employee: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
}) {
  return [
    text(employee.residenceAddress),
    text(employee.residenceArea),
    text(employee.residenceCity),
  ]
    .filter(Boolean)
    .join(", ");
}

type EmployeeLookupMaps = {
  codeByName: Map<string, string>;
  codeByHrId: Map<string, string>;
  residenceByHrId: Map<string, string>;
  residenceByName: Map<string, string>;
};

async function buildEmployeeLookupMaps(): Promise<EmployeeLookupMaps> {
  try {
    const directory = await getEmployeeDirectory();
    const codeByName = new Map<string, string>();
    const codeByHrId = new Map<string, string>();
    const residenceByHrId = new Map<string, string>();
    const residenceByName = new Map<string, string>();

    directory.employees.forEach((employee) => {
      const hrId = text(employee.hrId).toUpperCase();
      const normalizedHrId = hrId.toLowerCase();
      const residence = resolveResidenceFromEmployee(employee);

      if (hrId) {
        codeByHrId.set(normalizedHrId, hrId);
      }

      if (residence) {
        if (normalizedHrId) {
          residenceByHrId.set(normalizedHrId, residence);
        }
        employeeNameKeys(employee.fullName, employee.nameAr, employee.crmUsername)
          .forEach((key) => {
            residenceByName.set(key, residence);
          });
      }

      employeeNameKeys(employee.fullName, employee.nameAr, employee.crmUsername).forEach((key) => {
        codeByName.set(key, employee.hrId);
      });
    });

    return {
      codeByName,
      codeByHrId,
      residenceByHrId,
      residenceByName,
    };
  } catch {
    return {
      codeByName: new Map<string, string>(),
      codeByHrId: new Map<string, string>(),
      residenceByHrId: new Map<string, string>(),
      residenceByName: new Map<string, string>(),
    };
  }
}

function buildHeaderLookup(columns: string[]) {
  const lookup = new Map<string, string>();

  columns.forEach((header) => {
    const normalized = normalizeHeaderName(header);
    if (!lookup.has(normalized)) {
      lookup.set(normalized, header);
    }
  });

  return lookup;
}

function normalizeHeaderName(raw: string) {
  return normalizeHeaderKey(text(raw));
}

function rowValue(
  row: Record<string, unknown>,
  columnLookup: Map<string, string>,
  ...aliases: string[]
) {
  for (const alias of aliases) {
    const aliasKey = normalizeHeaderName(alias);
    const key = columnLookup.get(aliasKey);
    if (key !== undefined && row[key] !== undefined) {
      return row[key];
    }
  }

  return "";
}

type HeaderValueResolver = (...aliases: string[]) => unknown;

function detectHeaderRowNumber(worksheet: ExcelJS.Worksheet) {
  const maxRowsToInspect = Math.min(worksheet.rowCount, 15);
  let bestRow = 1;
  let bestScore = -1;

  for (let rowNumber = 1; rowNumber <= maxRowsToInspect; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    let matchScore = 0;
    let hasHeaderDensity = 0;

    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const rawHeader = excelCellText(row.getCell(column).value);
      const normalized = normalizeHeaderName(rawHeader);
      if (!normalized) continue;

      hasHeaderDensity += 1;

      if (expenseHeaderAliasSet.has(normalized)) {
        matchScore += 2;
      } else if (normalized.length > 3 && !/^\d+$/.test(normalized)) {
        matchScore += 1;
      }
    }

    if (hasHeaderDensity > 2 && (matchScore > bestScore || (matchScore === bestScore && rowNumber < bestRow))) {
      bestScore = matchScore;
      bestRow = rowNumber;
    }
  }

  return bestScore >= 4 ? bestRow : 1;
}

function isSpecialistMarker(value: unknown) {
  return text(value).toLowerCase().startsWith("specialist :");
}

function isSubtotalRow(valueBy: HeaderValueResolver) {
  const totalMarker = text(valueBy(...expenseHeaderAliases.columnSpecialist)).toLowerCase();
  const statusMarker = text(valueBy(...expenseHeaderAliases.columnStatus)).toLowerCase();
  const tripIdMarker = text(valueBy(...expenseHeaderAliases.columnTripId)).toLowerCase();
  const isTotalRow =
    totalMarker === "total" ||
    totalMarker === "grand total" ||
    statusMarker === "total" ||
    tripIdMarker.startsWith("total") ||
    tripIdMarker.startsWith(":");

  return isTotalRow || statusMarker === "subtotal";
}

function isTripRow(valueBy: HeaderValueResolver) {
  const tripId = text(valueBy(...expenseHeaderAliases.columnTripId));
  const specialist = text(valueBy(...expenseHeaderAliases.columnSpecialist, ...expenseHeaderAliases.columnHrId));
  const dateValue = text(valueBy(...expenseHeaderAliases.columnDate, ...expenseHeaderAliases.columnToDate));
  const destination = text(valueBy(...expenseHeaderAliases.columnTo, ...expenseHeaderAliases.columnLocation));
  const travelCost = numberValue(valueBy(...expenseHeaderAliases.columnTravelCost));
  const meetingAmount = numberValue(valueBy(...expenseHeaderAliases.columnMeeting));
  const allowance = numberValue(valueBy(...expenseHeaderAliases.columnAllowance));
  const km = numberValue(valueBy(...expenseHeaderAliases.columnKm));

  if (tripId && isSpecialistMarker(tripId)) return false;
  if (isSubtotalRow(valueBy)) return false;

  return Boolean(tripId || specialist || dateValue || destination || travelCost || meetingAmount || allowance || km);
}

function parseDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return date.toISOString();
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function employeeNameKeys(...values: Array<string | null | undefined>) {
  const keys = new Set<string>();

  values.forEach((value) => {
    const raw = text(value);
    if (!raw) return;

    const compacted = normalizeName(raw);
    if (compacted) keys.add(compacted);

    const parts = raw.split(/[\s._-]+/g).filter(Boolean);
    if (parts.length >= 2) {
      keys.add(normalizeName(`${parts[0]} ${parts[parts.length - 1]}`));
    }
  });

  return Array.from(keys);
}

function resolveHrIdFromEmployeeMaps(
  employeeMaps: EmployeeLookupMaps,
  specialist: string,
  fileHrId: string,
) {
  const normalizedFileHrId = fileHrId.toLowerCase();
  const byFileId = normalizedFileHrId ? employeeMaps.codeByHrId.get(normalizedFileHrId) : null;
  if (byFileId) return byFileId;

  return employeeNameKeys(specialist)
    .map((key) => employeeMaps.codeByName.get(key))
    .find(Boolean) ??
    (fileHrId || null);
}

function resolveFromFromEmployeeMaps(
  employeeMaps: EmployeeLookupMaps,
  hrId: string | null,
  specialist: string,
) {
  if (hrId) {
    const fromByHr = employeeMaps.residenceByHrId.get(hrId.toLowerCase());
    if (fromByHr) return fromByHr;
  }

  return employeeNameKeys(specialist)
    .map((key) => employeeMaps.residenceByName.get(key))
    .find(Boolean) ?? "";
}

function specialistSummary(records: ExpenseTripRecord[]) {
  const grouped = new Map<string, ExpenseSpecialistSummary>();

  for (const record of records) {
    const existing =
      grouped.get(record.specialist) ??
      {
        allowance: 0,
        meetingAmount: 0,
        specialist: record.specialist || "Unassigned",
        total: 0,
        travelCost: 0,
        trips: 0,
      };

    existing.allowance += record.allowance;
    existing.meetingAmount += record.meetingAmount;
    existing.total += record.total;
    existing.travelCost += record.travelCost;
    existing.trips += 1;
    grouped.set(existing.specialist, existing);
  }

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      allowance: roundCurrency(row.allowance),
      meetingAmount: roundCurrency(row.meetingAmount),
      total: roundCurrency(row.total),
      travelCost: roundCurrency(row.travelCost),
    }))
    .sort((left, right) => right.total - left.total);
}

export async function analyzeExpenseWorkbook(file: File): Promise<ExpenseAnalysisResult> {
  const employeeMaps = await buildEmployeeLookupMaps();
  const workbook = await loadExcelWorkbook(await file.arrayBuffer());
  const sheet = firstExcelWorksheet(workbook);

  if (!sheet) {
    throw new Error("Expenses workbook has no readable sheets.");
  }

  const headerRowNumber = detectHeaderRowNumber(sheet);
  const rows = excelWorksheetToJsonRows(sheet, headerRowNumber);
  const columns = Object.keys(rows[0] ?? {});
  const columnLookup = buildHeaderLookup(columns);
  const template = detectExpenseTemplate(file.name, sheet.name, columns);
  const records: ExpenseTripRecord[] = [];
  const warnings: string[] = [];
  let currentSpecialist = "";

  rows.forEach((row, index) => {
    const rowNumber = headerRowNumber + index + 1;
    const rowValueByAlias = (...keys: string[]) => rowValue(row, columnLookup, ...keys);

    const rowTripId = rowValueByAlias(...expenseHeaderAliases.columnTripId);
    if (rowTripId && isSpecialistMarker(rowTripId)) {
      currentSpecialist = text(rowTripId).replace(/^specialist\s*:\s*/i, "").trim();
      return;
    }

    if (isSubtotalRow(rowValueByAlias)) return;
    if (!isTripRow(rowValueByAlias)) return;

    const specialist = text(rowValueByAlias(...expenseHeaderAliases.columnSpecialist)) || currentSpecialist || "Unassigned";
    const travelCost = numberValue(rowValueByAlias(...expenseHeaderAliases.columnTravelCost));
    const meetingAmount = numberValue(rowValueByAlias(...expenseHeaderAliases.columnMeeting));
    const allowance = numberValue(rowValueByAlias(...expenseHeaderAliases.columnAllowance));
    const expectedTotal = numberValue(rowValueByAlias(...expenseHeaderAliases.columnExpected));
    const totalCell = rowValueByAlias(...expenseHeaderAliases.columnTotal);
    const total = text(totalCell)
      ? numberValue(totalCell)
      : expectedTotal;
    const fileHrId = text(rowValueByAlias(...expenseHeaderAliases.columnHrId));
    const tripId = text(rowValueByAlias(...expenseHeaderAliases.columnTripId)) || `ROW-${rowNumber}`;
    const hrId = resolveHrIdFromEmployeeMaps(employeeMaps, specialist, fileHrId);
    const expectedFrom = text(rowValueByAlias(...expenseHeaderAliases.columnFrom));
    const residenceFrom = resolveFromFromEmployeeMaps(employeeMaps, hrId, specialist);
    const resolvedFrom = expectedFrom || residenceFrom;
    const comments = text(rowValueByAlias(...expenseHeaderAliases.columnComments));

    if (template.recognized && !expectedFrom && !residenceFrom && specialist !== "Unassigned") {
      warnings.push(`Row ${rowNumber} / ${tripId}: '${specialist}' has no From column and no residence match in employee records.`);
    }
    if (template.recognized && !expectedFrom && residenceFrom) {
      warnings.push(
        `Row ${rowNumber} / ${tripId}: From was calculated from employee residence (${residenceFrom}).`,
      );
    }

    const hasExpected = Boolean(text(rowValueByAlias(...expenseHeaderAliases.columnExpected)));

    if (!hasExpected && Math.abs(total - expectedTotal) > 1) {
      warnings.push(
        `Row ${rowNumber} / ${tripId} total is ${total}, but travel + meeting + allowance is ${expectedTotal}.`,
      );
    }

    records.push({
      allowance,
      amWorkload: numberValue(rowValueByAlias(...expenseHeaderAliases.columnAmWorkload)),
      date: parseDate(rowValueByAlias(...expenseHeaderAliases.columnDate)),
      description: text(rowValueByAlias(...expenseHeaderAliases.columnDescription)),
      hrId,
      from: resolvedFrom,
      hr: text(rowValueByAlias(...expenseHeaderAliases.columnHr)),
      hrNotes: comments || text(rowValueByAlias(...expenseHeaderAliases.columnHr, ...expenseHeaderAliases.columnRecommendation)),
      km: numberValue(rowValueByAlias(...expenseHeaderAliases.columnKm)),
      location: text(rowValueByAlias(...expenseHeaderAliases.columnLocation)),
      meetingAmount,
      open: text(rowValueByAlias(...expenseHeaderAliases.columnOpen)),
      pmWorkload: numberValue(rowValueByAlias(...expenseHeaderAliases.columnPmWorkload)),
      requestType: text(rowValueByAlias(...expenseHeaderAliases.columnRequestType)),
      row: rowNumber,
      specialist,
      status: text(rowValueByAlias(...expenseHeaderAliases.columnStatus, ...expenseHeaderAliases.columnHr)),
      to: text(rowValueByAlias(...expenseHeaderAliases.columnTo)),
      toDate: parseDate(rowValueByAlias(...expenseHeaderAliases.columnToDate)),
      total,
      transportationType: text(
        rowValueByAlias(...expenseHeaderAliases.columnTransportation, ...expenseHeaderAliases.columnTripType),
      ),
      travelCost,
      tripId,
      tripType: text(rowValueByAlias(...expenseHeaderAliases.columnTripType)),
    });
  });

  const specialists = specialistSummary(records);

  return {
    template,
    columns,
    fileName: file.name,
    records,
    specialists,
    summary: {
      confirmedByFinance: records.filter((record) =>
        record.status.toLowerCase().includes("confirmed by finance"),
      ).length,
      refusedByHr: records.filter((record) => record.hr.toLowerCase().includes("refused")).length,
      specialists: specialists.length,
      systemApproved: records.filter((record) =>
        record.status.toLowerCase().includes("system approval"),
      ).length,
      totalAllowance: roundCurrency(records.reduce((sum, record) => sum + record.allowance, 0)),
      totalExpenses: roundCurrency(records.reduce((sum, record) => sum + record.total, 0)),
      totalKm: records.reduce((sum, record) => sum + record.km, 0),
      totalMeetingAmount: roundCurrency(records.reduce((sum, record) => sum + record.meetingAmount, 0)),
      totalTravelCost: roundCurrency(records.reduce((sum, record) => sum + record.travelCost, 0)),
      trips: records.length,
    },
    warnings,
  };
}
