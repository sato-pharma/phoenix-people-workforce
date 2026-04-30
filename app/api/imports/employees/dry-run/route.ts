import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const supportedExtensions = new Set([".xls", ".xlsx"]);
const supportedMimeTypes = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");

  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function isSupportedExcelFile(file: File) {
  const extension = getFileExtension(file.name);
  const mimeType = file.type.toLowerCase();

  return (
    supportedExtensions.has(extension) ||
    (mimeType.length > 0 && supportedMimeTypes.has(mimeType))
  );
}

async function parseExcelRows(file: File) {
  if (!isSupportedExcelFile(file)) {
    return { error: "unsupported_format" as const };
  }

  if (file.size === 0) {
    return { error: "invalid_excel_file" as const };
  }

  try {
    const workbook = XLSX.read(await file.arrayBuffer(), {
      cellDates: true,
      type: "array",
    });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return { error: "empty_worksheet" as const };
    }

    const firstSheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<RawEmployeeImportRow>(firstSheet, {
      defval: null,
    });

    if (rows.length === 0) {
      return { error: "empty_worksheet" as const };
    }

    return { rows };
  } catch {
    return { error: "invalid_excel_file" as const };
  }
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const parsed = await parseExcelRows(file);

  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  return NextResponse.json(createEmployeeImportPlan(parsed.rows));
}
