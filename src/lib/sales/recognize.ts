import ExcelJS from "exceljs";

import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { loadCrosswalks } from "@/lib/sales/normalizer/crosswalks";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { normalizeRows, validateSheetHeaders, type HeaderValidationFailure } from "@/lib/sales/normalizer/engine";
import { distinctUnknowns, type DistinctUnknown, type ProductRef } from "@/lib/sales/normalizer/mapping";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";

// ── The Sales recognition spine ──────────────────────────────────────────────────────────────
// THE single place that classifies an uploaded distributor workbook. Every sales workflow
// (Sales Upload, Source Normalizer, Missing Data, Diagnostics, the legacy upload path) MUST go
// through `recognizeDistributorWorkbook` so a file recognized in one place is recognized everywhere
// — the prime directive of the Sales rebuild. This module is recognition-only: it reads masters and
// the mapping dictionary but NEVER imports the persistence layer, keeping the import graph acyclic.

// Bump when recognition behavior changes (header detection, coded-sheet rules, normalization). The
// value is stamped onto results/lineage so an imported batch records which engine produced it.
export const RECOGNITION_ENGINE_VERSION = "2026.06-raw-1";

// Most-frequent invoice period among coded rows (the batch period).
export function dominantPeriod(rows: CodedRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.invoiceDate) counts.set(row.invoiceDate, (counts.get(row.invoiceDate) ?? 0) + 1);
  }
  let best: string | null = null; let bestN = 0;
  for (const [period, n] of counts) { if (n > bestN) { best = period; bestN = n; } }
  return best;
}

export type NormalizePreview = {
  distributorCode: string;
  distributorName: string;
  period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  summary: NormalizeResult["summary"];
  unknownCustomers: DistinctUnknown[];
  unknownProducts: DistinctUnknown[];
  unknownTerritories: DistinctUnknown[];
  // Surfaced to the UI for actionable callouts
  blankCustomerSkipped: number;
  blankCustomerErrors: number;
  darkCount: number;
};

export type NormalizeFileResult =
  | { status: "ok"; result: NormalizeResult; period: string | null; distributorName: string; products: ProductRef[]; valueSource: "recompute" | "sheet"; priceByCode: Map<string, number>; hasDateColumn: boolean; regionOnly: boolean }
  | { status: "header_error"; distributorName: string; missingGroups: HeaderValidationFailure[]; fingerprintWarning?: { likelyCode: string; likelyName: string } }
  | { status: "coded_sheet"; distributorName: string };

// Phoenix product code -> master factory price, keyed the same way the engine keys productByCode,
// so the post-analyze validator can sanity-check per-unit prices without re-loading the masters.
function buildPriceMap(products: { productCode: string; factoryPrice: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of products) map.set(normalizeCodeKey(p.productCode), Number(p.factoryPrice) || 0);
  return map;
}

// Recognize + normalize a raw distributor workbook WITHOUT persisting anything. Resolves the
// distributor profile, detects an already-coded sheet, validates the headers, then normalizes every
// row against the shared mapping dictionary (crosswalks). Returns a discriminated result the callers
// branch on. This is the canonical recognizer; `normalizeUploadedFile` is kept as an alias for the
// many existing call sites.
export async function recognizeDistributorWorkbook(distributorCode: string, file: File): Promise<NormalizeFileResult> {
  const profile = await resolveDistributorProfile(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  // Load masters + file buffer in parallel; load crosswalks only after coded-sheet and header checks pass.
  const [refs, buffer] = await Promise.all([loadSalesReferenceData(), file.arrayBuffer()]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const maps = await loadCrosswalks(refs);
    const result = normalizeRows(sheet as unknown as ExcelJS.Worksheet, profile, maps);
    const products: ProductRef[] = refs.products.map((p) => ({ code: p.productCode, family: p.family, name: p.productName }));
    return { status: "ok", result, period: null, distributorName: profile.distributorName, products, valueSource: profile.valueSource, priceByCode: buildPriceMap(refs.products), hasDateColumn: (profile.dateColumns ?? []).length > 0, regionOnly: Boolean(profile.regionOnly) };
  }

  // Coded-sheet detection: Phoenix-branded coded sheets carry "Product ID" / "Distrub ID" — raw
  // distributor exports never do. Running a coded sheet through the normalizer produces garbage.
  const codedIndicators = ["product id", "distrub id", "region id"];
  let codedHits = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 5); r += 1) {
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      const key = String(cell.value ?? "").trim().toLowerCase();
      if (codedIndicators.includes(key)) codedHits += 1;
    });
    if (codedHits >= 2) return { status: "coded_sheet", distributorName: profile.distributorName };
  }

  // Per-distributor pre-flight header validation.
  const headerValidation = validateSheetHeaders(sheet, profile, RAW_DISTRIBUTOR_PROFILES);
  if (!headerValidation.valid) {
    return {
      status: "header_error",
      distributorName: profile.distributorName,
      missingGroups: headerValidation.missingGroups,
      fingerprintWarning: headerValidation.fingerprintWarning,
    };
  }

  const maps = await loadCrosswalks(refs);
  const result = normalizeRows(sheet, profile, maps);
  const products: ProductRef[] = refs.products.map((p) => ({ code: p.productCode, family: p.family, name: p.productName }));
  return { status: "ok", result, period: dominantPeriod(result.coded), distributorName: profile.distributorName, products, valueSource: profile.valueSource, priceByCode: buildPriceMap(refs.products), hasDateColumn: (profile.dateColumns ?? []).length > 0, regionOnly: Boolean(profile.regionOnly) };
}

// Backwards-compatible alias for the canonical recognizer (kept for existing call sites).
export const normalizeUploadedFile = recognizeDistributorWorkbook;

export function summarizePreview(distributorCode: string, distributorName: string, result: NormalizeResult, products: ProductRef[]): NormalizePreview {
  const periodCounts = new Map<string, number>();
  result.coded.forEach((r) => { if (r.invoiceDate) periodCounts.set(r.invoiceDate, (periodCounts.get(r.invoiceDate) ?? 0) + 1); });
  const distinct = distinctUnknowns(result.exceptions, products);
  return {
    distributorCode,
    distributorName,
    period: dominantPeriod(result.coded),
    periods: [...periodCounts.entries()].map(([period, rows]) => ({ period, rows })).sort((a, b) => a.period.localeCompare(b.period)),
    sampleCoded: result.coded.slice(0, 50),
    summary: result.summary,
    unknownCustomers: distinct.customers.slice(0, 500),
    unknownProducts: distinct.products.slice(0, 500),
    unknownTerritories: distinct.territories.slice(0, 500),
    blankCustomerSkipped: result.summary.blankCustomerSkipped,
    blankCustomerErrors: distinct.blankCustomerErrors,
    darkCount: distinct.darkCount,
  };
}
