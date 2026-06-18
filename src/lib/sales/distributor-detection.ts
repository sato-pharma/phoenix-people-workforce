import { detectDistributor, type DetectionProfile, type DetectionResult } from "@/lib/sales/normalizer/detect-distributor";
import { listEditableProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { excelCellText, firstExcelWorksheet, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";

// Shared distributor auto-detection — the single place that turns an uploaded workbook's header row
// into a best-matching distributor. Used by both the upload detect route and the Diagnostics Center.

// Most likely header row from the first ~10 rows (most non-empty cells — robust against a merged
// title row above the real headers).
export async function extractHeaders(buffer: ArrayBuffer): Promise<string[]> {
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

export function buildDetectionProfiles(profiles: Awaited<ReturnType<typeof listEditableProfiles>>): DetectionProfile[] {
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

const EMPTY_DETECTION: DetectionResult = { ambiguous: false, best: null, confidence: "none", matches: [] };

export async function detectDistributorFromBuffer(buffer: ArrayBuffer): Promise<DetectionResult> {
  const headers = await extractHeaders(buffer);
  if (headers.length === 0) return EMPTY_DETECTION;
  const profiles = await listEditableProfiles();
  return detectDistributor(headers, buildDetectionProfiles(profiles));
}
