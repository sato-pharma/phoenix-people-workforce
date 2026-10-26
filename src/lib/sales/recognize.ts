import ExcelJS from "exceljs";

import { stripRestrictedRows } from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { loadCrosswalks } from "@/lib/sales/normalizer/crosswalks";
import { listMergedDistributorProfiles, resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { headerRowTexts, normalizeRows, pickBestSheet, validateSheetHeaders, type HeaderValidationFailure } from "@/lib/sales/normalizer/engine";
import { distinctUnknowns, type DistinctUnknown, type ProductRef } from "@/lib/sales/normalizer/mapping";
import {
  PHOENIX_TEMPLATE_BASE_PROFILE,
  PHOENIX_TEMPLATE_NAME,
  detectTemplateDistributor,
  isPhoenixTemplateCode,
  phoenixTemplateProfile,
  type TemplateDistributorRun,
} from "@/lib/sales/normalizer/phoenix-template";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, DistributorProfile, NormalizeResult } from "@/lib/sales/normalizer/types";
import type { ProductPeriodPrices } from "@/lib/sales/product-period-price";

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

// One distinct ignored product the user must explicitly review before importing.
// Only rows whose reason === "ignore_mapped" are surfaced here — bonus/free-goods rows
// are sheet-level flags and are never surfaced for review.
export type DistinctIgnoredItem = {
  raw: string;         // raw value from the sheet (product code or name column)
  displayName: string; // best human-readable name: rawProductName → master name → raw
  count: number;       // number of rows carrying this raw product
  totalQty: number;    // sum of qty across those rows
};

// One row the analyzer dropped before mapping, listed whole so the "N ignored" count on the Needs mapping tab can be read row by row.
export type PreviewIgnoredRow = {
  rowNumber: number; // the row's number in the sheet
  rawProduct: string; // the product code or name as the sheet wrote it
  productName: string; // best human-readable name
  qty: number; // the units the sheet carried on the row
  reason: "ignore_mapped" | "bonus";
  fileName?: string; // which file the row is in, when several files were uploaded together
};

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
  // Items the user must explicitly confirm (ignore or include) before importing
  ignoredItems: DistinctIgnoredItem[];
  // EVERY ignored row, uncut (the Ignored rows tab). ignoredItems above is the same rows grouped by product.
  ignoredRows: PreviewIgnoredRow[];
  // How many distinct unknowns there REALLY are, before PREVIEW_UNKNOWN_LIMIT truncates the three
  // lists above. Without these the UI silently showed the first 500 and looked like the whole job,
  // which is how "the normalizer maps a very small number per click" was invisible from the screen.
  // `rows` is the rows a mapping would unblock (see DistinctUnknowns.rowsNeedingMapping).
  unknownTotals: { customers: number; products: number; territories: number; rows: number };
  // Surfaced to the UI for actionable callouts
  blankCustomerSkipped: number;
  blankCustomerErrors: number;
  darkCount: number;
};

/**
 * How many distinct unknowns of each kind one preview carries back.
 *
 * Was 500, which quietly capped a month's mapping work at 500 customers however many the file
 * actually had. 2,000 matches BACKFILL_MAX_MAPPINGS (the biggest save the mapping layer will do in
 * one go), so the screen can no longer promise less than one click can deliver.
 */
export const PREVIEW_UNKNOWN_LIMIT = 2000;

export type NormalizeFileResult =
  // `distributorCode` is the RESOLVED distributor, which is only ever different from the code the
  // caller passed when the file came in on the Phoenix template (where the sheet names its own
  // distributor). Every caller must file mappings, the batch and the customer crosswalk under THIS
  // code — passing the sentinel through would file a month under a distributor that does not exist.
  // `prices` values a row in a given month (the crosswalks' own resolver); the upload flow uses it to
  // move a row's value to the month the operator files it under. Optional so hand-built results stay valid.
  | { status: "ok"; result: NormalizeResult; period: string | null; distributorCode: string; distributorName: string; products: ProductRef[]; valueSource: "recompute" | "sheet"; priceByCode: Map<string, number>; prices?: Pick<ProductPeriodPrices, "priceFor">; hasDateColumn: boolean; regionOnly: boolean }
  | { status: "header_error"; distributorName: string; missingGroups: HeaderValidationFailure[]; fingerprintWarning?: { likelyCode: string; likelyName: string }; observedHeaders: string[] }
  // The file came in on the Phoenix template but the template itself cannot be read — no distributor
  // named, a name the system does not know, or two distributors in one file. `message` is already
  // written for the user, so callers surface it verbatim instead of a generic refusal.
  | { status: "template_error"; distributorName: string; message: string }
  | { status: "coded_sheet"; distributorName: string };

/** One distributor's worth of a recognized file — the unit a batch is filed in. */
export type NormalizePart = {
  distributorCode: string;
  distributorName: string;
  result: NormalizeResult;
  period: string | null;
};

/**
 * A recognized file, split into one part per distributor.
 *
 * Every real distributor's own export is one part, always. Only the Phoenix universal template can
 * produce several, because it is the one sheet that names its distributor per row — and the
 * owner's rule is that one filled template may carry as many as he likes, each landing as its own
 * batch (2026-09-18).
 */
export type NormalizePartsResult =
  | {
      status: "ok";
      parts: NormalizePart[];
      products: ProductRef[];
      valueSource: "recompute" | "sheet";
      priceByCode: Map<string, number>;
      prices?: Pick<ProductPeriodPrices, "priceFor">;
      hasDateColumn: boolean;
      regionOnly: boolean;
    }
  | Exclude<NormalizeFileResult, { status: "ok" }>;

/**
 * The sentence to show the user for a non-ok recognition.
 *
 * Every normalizer route used to answer the same generic "The sheet could not be normalized — check
 * the distributor selection or sheet format", which told the user nothing about WHICH column was
 * missing or WHICH distributor name the template carried. The recognizer already knows; this is the
 * one place that turns what it knows into words.
 */
export function recognitionErrorMessage(result: Exclude<NormalizeFileResult, { status: "ok" }>): string {
  if (result.status === "template_error") return result.message;
  if (result.status === "coded_sheet") {
    return "This is already a coded Phoenix sheet, not a raw distributor file. Import it on Source of Sales instead.";
  }
  const missing = result.missingGroups
    .map((g) => (g.expected.length > 0 ? `${g.label} (expected the column "${g.expected[0]}")` : g.label))
    .join("; ");
  const warning = result.fingerprintWarning
    ? ` The columns look like ${result.fingerprintWarning.likelyName}'s file — check the distributor you picked.`
    : "";
  const observed = result.observedHeaders.length > 0 ? ` The file's own columns are: ${result.observedHeaders.join(", ")}.` : "";
  return `${result.distributorName}: the sheet is missing ${missing || "the required columns"}.${warning}${observed}`;
}

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
// branch on, SPLIT INTO ONE PART PER DISTRIBUTOR — one for every file but a Phoenix template naming
// several. `recognizeDistributorWorkbook` below is the one-distributor face of this, and what every
// caller outside the Source Normalizer uses (`normalizeUploadedFile` is its long-standing alias).
export async function recognizeWorkbookParts(distributorCode: string, file: File): Promise<NormalizePartsResult> {
  // The Phoenix template is not a distributor: the sheet NAMES its distributor, and we resolve that
  // name to a real code below, after the workbook is open. Until then it borrows the template's
  // headers-only profile so the right worksheet can be picked.
  const isTemplate = isPhoenixTemplateCode(distributorCode);
  let profile: DistributorProfile | null = isTemplate
    ? PHOENIX_TEMPLATE_BASE_PROFILE
    : await resolveDistributorProfile(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  // Loaded at most once per call, and only when something actually needs it.
  let mergedProfiles: DistributorProfile[] | null = null;
  const merged = async () => (mergedProfiles ??= await listMergedDistributorProfiles());
  // Load masters + file buffer in parallel; load crosswalks only after coded-sheet and header checks pass.
  // No customer→brick crosswalk here: loadCrosswalks reads the customer map itself.
  const [refs, buffer] = await Promise.all([loadSalesReferenceData({ includeCustomerBricks: false }), file.arrayBuffer()]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  // Pick the sheet that actually carries this distributor's data (cover/summary tabs are skipped), and
  // use that SAME sheet for coded-sheet detection, header validation, and normalization so analyze and
  // import never read different tabs.
  const sheet = pickBestSheet(workbook, profile);
  if (!sheet) {
    // The workbook parsed but has no usable data sheet (zero worksheets / all empty). Return the
    // normal "header_error" the callers already handle, instead of force-casting `undefined` into
    // normalizeRows — that crashed with "Cannot read properties of undefined (reading 'rowCount')"
    // and surfaced as a raw 500 rather than a clean validation message.
    return {
      status: "header_error",
      distributorName: profile.distributorName,
      missingGroups: [{ label: "Worksheet", expected: ["a non-empty data sheet"] }],
      observedHeaders: [],
    };
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

  // Phoenix template: read the distributor off the sheet and rebuild the profile under its REAL code,
  // so normalizeRows stamps the real distributor on every coded row and keys the customer crosswalk
  // `${realDistributor} ${customerCode}` exactly as it does for that distributor's own file.
  let templateRuns: TemplateDistributorRun[] = [];
  let rowOwner: Map<number, string> = new Map();
  if (isTemplate) {
    const detection = detectTemplateDistributor(
      sheet,
      (await merged()).map((p) => ({ distributorCode: p.distributorCode, distributorName: p.distributorName })),
    );
    if (!detection.ok) {
      return { status: "template_error", distributorName: profile.distributorName, message: detection.message };
    }
    templateRuns = detection.distributors;
    rowOwner = detection.distributorByRow;
    // Header validation below runs against the FIRST distributor's profile: every part of a template
    // file shares the template's headers, so one check answers for all of them.
    profile = phoenixTemplateProfile(templateRuns[0].distributorCode, templateRuns[0].distributorName);
  }

  // Per-distributor pre-flight header validation. The fingerprint cross-check scores against the MERGED
  // profile set (code ∪ DB overrides) so an in-app edited/onboarded distributor participates too.
  const headerValidation = validateSheetHeaders(sheet, profile, await merged());
  if (!headerValidation.valid) {
    return {
      status: "header_error",
      distributorName: profile.distributorName,
      missingGroups: headerValidation.missingGroups,
      fingerprintWarning: headerValidation.fingerprintWarning,
      observedHeaders: headerRowTexts(sheet, profile), // column titles only — for the AI explainer + UI
    };
  }

  const maps = await loadCrosswalks(refs);
  const products: ProductRef[] = refs.products.map((p) => ({ code: p.productCode, family: p.family, name: p.productName }));
  const parts: NormalizePart[] = [];
  if (templateRuns.length > 1) {
    // One pass of the engine per distributor, over that distributor's own rows. Each pass carries
    // its OWN profile, so every coded row is stamped with the real distributor and the customer
    // crosswalk is keyed `${realDistributor} ${customerCode}` exactly as that distributor's own file
    // would have keyed it.
    for (const run of templateRuns) {
      const partProfile = phoenixTemplateProfile(run.distributorCode, run.distributorName);
      const result = normalizeRows(sheet, partProfile, maps, { includeRow: (r) => rowOwner.get(r) === run.distributorCode });
      parts.push({ distributorCode: partProfile.distributorCode, distributorName: run.distributorName, period: dominantPeriod(result.coded), result });
    }
  } else {
    // The ordinary file: one distributor, no filter, byte-for-byte the pass this has always made.
    const result = normalizeRows(sheet, profile, maps);
    parts.push({ distributorCode: profile.distributorCode, distributorName: profile.distributorName, period: dominantPeriod(result.coded), result });
  }
  return { status: "ok", parts, products, valueSource: profile.valueSource, priceByCode: buildPriceMap(refs.products), prices: maps.prices, hasDateColumn: (profile.dateColumns ?? []).length > 0, regionOnly: Boolean(profile.regionOnly) };
}

/**
 * The canonical recognizer, one distributor at a time — what every sales workflow outside the
 * Source Normalizer calls, and what its contract has always been.
 *
 * A file carrying several distributors can only be a Phoenix template (nothing else names its
 * distributor per row), and only the Source Normalizer offers that option, so this refuses it in
 * words rather than silently recognizing the first one and dropping the rest.
 */
export async function recognizeDistributorWorkbook(distributorCode: string, file: File): Promise<NormalizeFileResult> {
  const recognized = await recognizeWorkbookParts(distributorCode, file);
  if (recognized.status !== "ok") return recognized;
  const [first, ...rest] = recognized.parts;
  if (rest.length > 0) {
    return {
      status: "template_error",
      distributorName: PHOENIX_TEMPLATE_NAME,
      message: `This file carries ${recognized.parts.length} distributors (${recognized.parts.map((p) => p.distributorName).join(", ")}). Upload it on the Source Normalizer, which files one batch per distributor.`,
    };
  }
  return {
    status: "ok",
    result: first.result,
    period: first.period,
    distributorCode: first.distributorCode,
    distributorName: first.distributorName,
    products: recognized.products,
    valueSource: recognized.valueSource,
    priceByCode: recognized.priceByCode,
    prices: recognized.prices,
    hasDateColumn: recognized.hasDateColumn,
    regionOnly: recognized.regionOnly,
  };
}

// Backwards-compatible alias for the canonical recognizer (kept for existing call sites).
export const normalizeUploadedFile = recognizeDistributorWorkbook;

export function summarizePreview(
  distributorCode: string,
  distributorName: string,
  result: NormalizeResult,
  products: ProductRef[],
  excludeProductCodes: readonly string[] = [],
): NormalizePreview {
  const periodCounts = new Map<string, number>();
  result.coded.forEach((r) => { if (r.invoiceDate) periodCounts.set(r.invoiceDate, (periodCounts.get(r.invoiceDate) ?? 0) + 1); });
  const distinct = distinctUnknowns(result.exceptions, products);

  // Build a master-product lookup so we can show a friendly name when the sheet only has a code.
  const masterNameByCode = new Map(products.map((p) => [normalizeCodeKey(p.code), p.name]));

  // Deduplicate ignore_mapped rows by rawProduct — bonus rows (sheet-level free-goods flag) are excluded.
  // Use "not bonus" rather than "must be ignore_mapped" so rows from any code path are surfaced by default.
  const ignoredMap = new Map<string, DistinctIgnoredItem>();
  for (const row of result.ignoredRows) {
    if (row.reason === "bonus") continue;
    let entry = ignoredMap.get(row.rawProduct);
    if (!entry) {
      const displayName = row.rawProductName
        || masterNameByCode.get(normalizeCodeKey(row.rawProduct))
        || row.rawProduct;
      entry = { raw: row.rawProduct, displayName, count: 0, totalQty: 0 };
      ignoredMap.set(row.rawProduct, entry);
    }
    entry.count += 1;
    entry.totalQty += Number.isFinite(row.qty) ? row.qty : 0;
  }

  return {
    distributorCode,
    distributorName,
    period: dominantPeriod(result.coded),
    periods: [...periodCounts.entries()].map(([period, rows]) => ({ period, rows })).sort((a, b) => a.period.localeCompare(b.period)),
    // Confidential products (LA003/LA004/SS001) are stripped before sampling — this preview is a raw
    // row sample (product/customer identity included), so it must never leak a restricted product the
    // same way buildPreviewBreakdowns already protects the aggregated tables.
    sampleCoded: stripRestrictedRows(result.coded, excludeProductCodes).slice(0, 50),
    summary: result.summary,
    unknownCustomers: distinct.customers.slice(0, PREVIEW_UNKNOWN_LIMIT),
    unknownProducts: distinct.products.slice(0, PREVIEW_UNKNOWN_LIMIT),
    unknownTerritories: distinct.territories.slice(0, PREVIEW_UNKNOWN_LIMIT),
    unknownTotals: {
      customers: distinct.customers.length,
      products: distinct.products.length,
      territories: distinct.territories.length,
      rows: distinct.rowsNeedingMapping,
    },
    ignoredItems: [...ignoredMap.values()],
    ignoredRows: result.ignoredRows.map((row): PreviewIgnoredRow => ({
      rowNumber: row.rawRowNumber,
      rawProduct: row.rawProduct,
      productName: row.productName || row.rawProductName || masterNameByCode.get(normalizeCodeKey(row.rawProduct)) || row.rawProduct,
      qty: Number.isFinite(row.qty) ? row.qty : 0,
      reason: row.reason === "bonus" ? "bonus" : "ignore_mapped",
    })),
    blankCustomerSkipped: result.summary.blankCustomerSkipped,
    blankCustomerErrors: distinct.blankCustomerErrors,
    darkCount: distinct.darkCount,
  };
}
