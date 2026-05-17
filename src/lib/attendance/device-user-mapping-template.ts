import ExcelJS from "exceljs";

import { saveAttendanceDeviceUserMapping } from "@/lib/attendance/device-user-mapping";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const templateHeaders = ["device_id", "device_user_id", "employee_hr_id", "is_active", "notes"] as const;
const defaultDeviceId = process.env.ATTENDANCE_DEFAULT_DEVICE_ID || process.env.DEVICE_ID || "zkteco-main";

export type DeviceMappingImportFailure = {
  message: string;
  row: number;
};

export type DeviceMappingImportResult = {
  failed: number;
  failures: DeviceMappingImportFailure[];
  imported: number;
  received: number;
};

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function cellText(row: ExcelJS.Row, columnNumber: number) {
  const value = row.getCell(columnNumber).value;
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

function parseBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "active"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "inactive", ""].includes(normalized)) return false;
  throw new Error("is_active must be TRUE or FALSE.");
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = row.values as unknown[];
    const normalized = headers.map(normalizeHeader);
    if (templateHeaders.every((header) => normalized.includes(header))) {
      return rowNumber;
    }
  }
  return null;
}

function buildHeaderMap(worksheet: ExcelJS.Worksheet, headerRowNumber: number) {
  const map = new Map<string, number>();
  const row = worksheet.getRow(headerRowNumber);
  row.eachCell((cell, columnNumber) => {
    const header = normalizeHeader(cell.value);
    if (header) map.set(header, columnNumber);
  });
  return map;
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.height = 24;
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
      left: { style: "thin", color: { argb: "FFE2E8F0" } },
      right: { style: "thin", color: { argb: "FFE2E8F0" } },
      top: { style: "thin", color: { argb: "FFE2E8F0" } },
    };
  });
}

function styleBodyRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { color: { argb: "FF0F172A" }, size: 10 };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFF1F5F9" } } };
  });
}

export async function generateDeviceMappingTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Device User Mapping", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").value = "Phoenix Workforce - Attendance Device User Mapping";
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC2410C" } };
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 15 };
  sheet.getCell("A1").alignment = { horizontal: "center" };

  sheet.mergeCells("A2:E2");
  sheet.getCell("A2").value = "Fill one row per fingerprint device user. employee_hr_id must exist in Phoenix employees.";
  sheet.getCell("A2").font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell("A2").alignment = { horizontal: "center" };

  sheet.addRow([]);
  sheet.addRow([...templateHeaders]);
  styleHeaderRow(sheet.getRow(4));

  const sampleRows = [
    [defaultDeviceId, "1", "B-185", true, "Example row - replace or delete"],
    [defaultDeviceId, "2", "B-210", true, "Example row - replace or delete"],
  ];
  for (const sample of sampleRows) {
    const row = sheet.addRow(sample);
    styleBodyRow(row);
  }

  sheet.columns = [
    { key: "device_id", width: 22 },
    { key: "device_user_id", width: 18 },
    { key: "employee_hr_id", width: 18 },
    { key: "is_active", width: 14 },
    { key: "notes", width: 36 },
  ];
  sheet.autoFilter = "A4:E4";

  for (let rowNumber = 5; rowNumber <= 500; rowNumber += 1) {
    sheet.getCell(`A${rowNumber}`).value = rowNumber <= 6 ? sheet.getCell(`A${rowNumber}`).value : defaultDeviceId;
    sheet.getCell(`D${rowNumber}`).dataValidation = {
      allowBlank: false,
      formulae: ['"TRUE,FALSE"'],
      type: "list",
    };
  }

  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [{ width: 30 }, { width: 90 }];
  instructions.addRows([
    ["Column", "Rule"],
    ["device_id", `Use ${defaultDeviceId} unless another device is added later.`],
    ["device_user_id", "Numeric ID from the fingerprint device."],
    ["employee_hr_id", "Must match employees.hr_id exactly, for example B-185."],
    ["is_active", "TRUE means Phoenix will resolve punches for this device user. FALSE disables the mapping."],
    ["notes", "Optional. Not imported into attendance calculations."],
  ]);
  styleHeaderRow(instructions.getRow(1));
  for (let row = 2; row <= instructions.rowCount; row += 1) {
    styleBodyRow(instructions.getRow(row));
  }

  return workbook;
}

export async function importDeviceMappingsFromWorkbook(file: File): Promise<DeviceMappingImportResult> {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(await file.arrayBuffer());
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const worksheet = workbook.getWorksheet("Device User Mapping") ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Uploaded workbook has no worksheets.");
  }

  const headerRowNumber = findHeaderRow(worksheet);
  if (!headerRowNumber) {
    throw new Error(`Template headers are missing. Required headers: ${templateHeaders.join(", ")}.`);
  }

  const headerMap = buildHeaderMap(worksheet, headerRowNumber);
  const supabase = getSupabaseAdmin();
  const employeeHrIds = new Set<string>();
  const rows: Array<{ deviceId: string; deviceUserId: string; employeeHrId: string | null; isActive: boolean; rowNumber: number }> = [];
  const failures: DeviceMappingImportFailure[] = [];

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const deviceId = cellText(row, headerMap.get("device_id") ?? 0) || defaultDeviceId;
    const deviceUserId = cellText(row, headerMap.get("device_user_id") ?? 0);
    const employeeHrId = cellText(row, headerMap.get("employee_hr_id") ?? 0).toUpperCase();
    const activeText = cellText(row, headerMap.get("is_active") ?? 0);

    if (![deviceId, deviceUserId, employeeHrId, activeText].some(Boolean)) continue;

    try {
      const isActive = parseBoolean(activeText || "true");
      if (!deviceUserId) throw new Error("device_user_id is required.");
      if (isActive && !employeeHrId) throw new Error("employee_hr_id is required for active mappings.");
      if (employeeHrId) employeeHrIds.add(employeeHrId);
      rows.push({ deviceId, deviceUserId, employeeHrId: employeeHrId || null, isActive, rowNumber });
    } catch (error) {
      failures.push({ row: rowNumber, message: error instanceof Error ? error.message : "Invalid row." });
    }
  }

  if (rows.length === 0 && failures.length === 0) {
    throw new Error("Template has no importable rows.");
  }

  if (employeeHrIds.size > 0) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id")
      .in("hr_id", Array.from(employeeHrIds));

    if (error) throw error;
    const existing = new Set(((data ?? []) as Array<{ hr_id: string }>).map((row) => row.hr_id.toUpperCase()));
    for (const row of rows) {
      if (row.employeeHrId && !existing.has(row.employeeHrId)) {
        failures.push({ row: row.rowNumber, message: `Employee HR_ID ${row.employeeHrId} does not exist.` });
      }
    }
  }

  const failedRows = new Set(failures.map((failure) => failure.row));
  let imported = 0;

  for (const row of rows) {
    if (failedRows.has(row.rowNumber)) continue;
    try {
      await saveAttendanceDeviceUserMapping({
        deviceId: row.deviceId,
        deviceUserId: row.deviceUserId,
        employeeHrId: row.employeeHrId,
        isActive: row.isActive,
      });
      imported += 1;
    } catch (error) {
      failures.push({ row: row.rowNumber, message: error instanceof Error ? error.message : "Mapping could not be saved." });
    }
  }

  return {
    failed: failures.length,
    failures,
    imported,
    received: rows.length,
  };
}
