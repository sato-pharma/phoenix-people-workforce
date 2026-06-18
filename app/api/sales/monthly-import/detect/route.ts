import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { detectDistributor, type DetectionProfile } from "@/lib/sales/normalizer/detect-distributor";
import { listEditableProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { SALES_IMPORT_BUCKET } from "@/lib/sales/monthly-import-request";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelCellText, firstExcelWorksheet, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: parse just the header row of the uploaded sheet and return the best-matching
// distributor(s). Used so the upload screen can pre-select the right distributor (and warn on a
// wrong manual pick). Persists nothing.

// Pick the most likely header row from the first ~10 rows (the row with the most non-empty cells —
// robust against a merged title row above the real headers).
async function extractHeaders(buffer: ArrayBuffer): Promise<string[]> {
  const workbook = await loadExcelWorkbook(buffer);
  const sheet = firstExcelWorksheet(workbook);
  if (!sheet) return [];
  let bestHeaders: string[] = [];
  const maxRow = Math.min(sheet.rowCount, 10);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const texts: string[] = [];
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      const text = excelCellText(row.getCell(column).value);
      if (text) texts.push(text);
    }
    if (texts.length > bestHeaders.length) bestHeaders = texts;
  }
  return bestHeaders;
}

function buildDetectionProfiles(profiles: Awaited<ReturnType<typeof listEditableProfiles>>): DetectionProfile[] {
  return profiles.map((p) => ({
    distributorCode: p.distributorCode,
    distributorName: p.distributorName,
    requiredGroups: [
      [...p.fields.productCodeColumns, ...p.fields.productNameColumns],
      p.fields.qtyColumns,
      p.fields.customerCodeColumns,
    ].filter((g) => g.length > 0),
    optionalGroups: [
      p.fields.customerNameColumns,
      p.fields.customerAddressColumns,
      p.fields.valueColumns,
      p.fields.discountColumns,
      p.fields.dateColumns,
      p.fields.bonusColumns,
    ].filter((g) => g.length > 0),
  }));
}

async function resolveBuffer(request: Request): Promise<{ buffer: ArrayBuffer } | { error: string; status: number }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { storagePath?: string };
    const path = String(body?.storagePath ?? "").trim();
    if (!path) return { error: "Uploaded file reference is missing.", status: 400 };
    const { data, error } = await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).download(path);
    if (error || !data) return { error: "Uploaded workbook was not found in storage.", status: 400 };
    return { buffer: await data.arrayBuffer() };
  }
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Sales workbook file is required.", status: 400 };
  return { buffer: await file.arrayBuffer() };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const resolved = await resolveBuffer(request);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error, success: false }, { status: resolved.status });
    }

    const headers = await extractHeaders(resolved.buffer);
    if (headers.length === 0) {
      return NextResponse.json({ data: { ambiguous: false, best: null, confidence: "none", matches: [] }, success: true });
    }

    const profiles = await listEditableProfiles();
    const detection = detectDistributor(headers, buildDetectionProfiles(profiles));
    return NextResponse.json({ data: detection, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden.", success: false }, { status: 403 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Distributor detection failed.", success: false }, { status: 500 });
  }
}
