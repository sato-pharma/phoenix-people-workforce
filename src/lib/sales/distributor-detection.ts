import { detectDistributor, normalizeHeader, type DetectionProfile, type DetectionResult } from "@/lib/sales/normalizer/detect-distributor";
import { listEditableProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { HEADER_SCAN_ROWS } from "@/lib/sales/normalizer/header-normalize";
import { SECOND_LAYOUT_PROFILES } from "@/lib/sales/normalizer/profiles";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";

// Shared distributor auto-detection — the single place that turns an uploaded workbook's header row
// into a best-matching distributor. Used by both the upload detect route and the Diagnostics Center.

// Pure: pick the most likely header row out of the first few scanned rows (each entry = that row's
// non-empty cell texts). Prefer the row matching the MOST known header names; fall back to the widest
// row only when nothing matches (an unknown file / no profiles supplied).
//
// Why not just "the widest row": a real header row can have BLANK columns that the data rows below it
// fill in — so a data row ends up wider than the header. The old "most non-empty cells" rule then
// grabbed a data row and detection saw pharmacy names / quantities instead of column titles and matched
// nothing. The EGD Branch export is exactly this shape (header row = 18 cells, data rows = 19).
export function pickBestHeaderRow(rows: string[][], knownHeaders?: ReadonlySet<string>): string[] {
  let best: string[] = [];
  let bestKnown = -1;
  let bestCount = -1;
  for (const texts of rows) {
    const known = knownHeaders ? texts.reduce((n, t) => n + (knownHeaders.has(normalizeHeader(t)) ? 1 : 0), 0) : 0;
    if (known > bestKnown || (known === bestKnown && texts.length > bestCount)) {
      best = texts;
      bestKnown = known;
      bestCount = texts.length;
    }
  }
  return best;
}

// The union of every header alias across all detection profiles (normalized) — used to recognize which
// scanned row is the real header even when it is not the widest row.
export function collectKnownHeaderAliases(profiles: DetectionProfile[]): Set<string> {
  const set = new Set<string>();
  for (const profile of profiles) {
    for (const group of [...profile.requiredGroups, ...profile.optionalGroups]) {
      for (const alias of group) {
        const normalized = normalizeHeader(alias);
        if (normalized) set.add(normalized);
      }
    }
  }
  return set;
}

// Most likely header row across ALL worksheets (the first HEADER_SCAN_ROWS rows of each). Iterating
// every sheet matches the importer's pickBestSheet so a file whose data lives on a later tab is still
// detected; scanning deeper rows catches a header sitting below a tall preamble. When knownHeaders is
// supplied, the row matching the most known column names wins (robust against a header row with blank
// columns the data rows fill, and against a merged title/banner row above the real headers).
export async function extractHeaders(buffer: ArrayBuffer, knownHeaders?: ReadonlySet<string>): Promise<string[]> {
  const workbook = await loadExcelWorkbook(buffer);
  const rows: string[][] = [];
  for (const sheet of workbook.worksheets) {
    if (!sheet || sheet.rowCount === 0 || sheet.columnCount === 0) continue;
    const maxRow = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const texts: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        const text = excelCellText(row.getCell(column).value);
        if (text) texts.push(text);
      }
      if (texts.length > 0) rows.push(texts);
    }
  }
  if (rows.length === 0) return [];
  return pickBestHeaderRow(rows, knownHeaders);
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

// The second templates, as detection candidates. EPDA Bulk 2 and EPDA Pharmacies 2 wear the columns of
// the separate source `EP`, so without these the detector names "epda" with high confidence and tells
// the person to switch to it, which would file EPDA-BULK's sales under the wrong source. With them the
// three tie and detection says it cannot tell, which is the truth: the person's pick decides.
export function secondLayoutDetectionProfiles(): DetectionProfile[] {
  return SECOND_LAYOUT_PROFILES.map((p) => ({
    distributorCode: p.distributorCode,
    distributorName: p.distributorName,
    requiredGroups: [[...(p.productCodeColumns ?? []), ...(p.productNameColumns ?? [])], p.qtyColumns, p.customerCodeColumns ?? []],
    optionalGroups: [p.customerNameColumns ?? [], p.customerAddressColumns ?? [], p.valueColumns ?? [], p.dateColumns ?? []],
  }));
}

const EMPTY_DETECTION: DetectionResult = { ambiguous: false, best: null, confidence: "none", matches: [] };

export async function detectDistributorFromBuffer(buffer: ArrayBuffer): Promise<DetectionResult> {
  const detectionProfiles = [...buildDetectionProfiles(await listEditableProfiles()), ...secondLayoutDetectionProfiles()];
  const knownHeaders = collectKnownHeaderAliases(detectionProfiles);
  const headers = await extractHeaders(buffer, knownHeaders);
  if (headers.length === 0) return EMPTY_DETECTION;
  return detectDistributor(headers, detectionProfiles);
}
