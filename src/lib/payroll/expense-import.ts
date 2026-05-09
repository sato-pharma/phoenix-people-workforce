import * as XLSX from "xlsx";

import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import type {
  ExpenseAnalysisResult,
  ExpenseSpecialistSummary,
  ExpenseTripRecord,
} from "@/lib/payroll/types";

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(text(value).replace(/^:/, "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowValue(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }

  return "";
}

const employeeCodeAliases = [
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
];

function parseDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return date.toISOString();
}

function isSpecialistMarker(row: Record<string, unknown>) {
  return text(row.TripID).toLowerCase().startsWith("specialist :");
}

function specialistFromMarker(row: Record<string, unknown>) {
  return text(row.TripID).replace(/^specialist\s*:\s*/i, "").trim();
}

function isSubtotalRow(row: Record<string, unknown>) {
  return !text(row.TripID) && text(row["Travel Cost"]).startsWith(":");
}

function isTripRow(row: Record<string, unknown>) {
  return Boolean(text(row.TripID) && !isSpecialistMarker(row));
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

async function buildEmployeeCodeMap() {
  try {
    const directory = await getEmployeeDirectory();
    const map = new Map<string, string>();

    directory.employees.forEach((employee) => {
      employeeNameKeys(employee.fullName, employee.nameAr, employee.crmUsername).forEach((key) => {
        map.set(key, employee.hrId);
      });
    });

    return map;
  } catch {
    return new Map<string, string>();
  }
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

  return Array.from(grouped.values()).sort((left, right) => right.total - left.total);
}

export async function analyzeExpenseWorkbook(file: File): Promise<ExpenseAnalysisResult> {
  const employeeCodeByName = await buildEmployeeCodeMap();
  const workbook = XLSX.read(await file.arrayBuffer(), {
    cellDates: true,
    type: "array",
  });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("Expenses workbook has no readable sheets.");
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  const columns = Object.keys(rows[0] ?? {});
  const records: ExpenseTripRecord[] = [];
  const warnings: string[] = [];
  let currentSpecialist = "";

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    if (isSpecialistMarker(row)) {
      currentSpecialist = specialistFromMarker(row);
      return;
    }

    if (isSubtotalRow(row)) return;
    if (!isTripRow(row)) return;

    const specialist = text(row.Specialist) || currentSpecialist || "Unassigned";
    const travelCost = numberValue(row["Travel Cost"]);
    const meetingAmount = numberValue(row["Meeting Amount"]);
    const allowance = numberValue(row.Allowance);
    const total = numberValue(row.Total);
    const expectedTotal = travelCost + meetingAmount + allowance;
    const fileHrId = text(rowValue(row, ...employeeCodeAliases));
    const hrId =
      fileHrId ||
      employeeNameKeys(specialist)
        .map((key) => employeeCodeByName.get(key))
        .find(Boolean) ||
      null;

    if (Math.abs(total - expectedTotal) > 1) {
      warnings.push(
        `Row ${rowNumber} / ${text(row.TripID)} total is ${total}, but travel + meeting + allowance is ${expectedTotal}.`,
      );
    }

    records.push({
      allowance,
      amWorkload: numberValue(row["AM Workload"]),
      date: parseDate(row.Date),
      description: text(row.Description),
      hrId,
      from: text(row.From),
      hr: text(row.HR),
      hrNotes: text(row["HR Notes"]),
      km: numberValue(row.KM),
      location: text(rowValue(row, "__EMPTY", "Unnamed: 9")),
      meetingAmount,
      open: text(row.Open),
      pmWorkload: numberValue(row["PM Workload"]),
      requestType: text(row["Request Type"]),
      row: rowNumber,
      specialist,
      status: text(row.Status),
      to: text(row.To),
      toDate: parseDate(row["To Date"]),
      total,
      transportationType: text(row["Transportation Type"]),
      travelCost,
      tripId: text(row.TripID),
      tripType: text(row["Trip Type"]),
    });
  });

  const specialists = specialistSummary(records);

  return {
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
      totalAllowance: records.reduce((sum, record) => sum + record.allowance, 0),
      totalExpenses: records.reduce((sum, record) => sum + record.total, 0),
      totalKm: records.reduce((sum, record) => sum + record.km, 0),
      totalMeetingAmount: records.reduce((sum, record) => sum + record.meetingAmount, 0),
      totalTravelCost: records.reduce((sum, record) => sum + record.travelCost, 0),
      trips: records.length,
    },
    warnings,
  };
}
