// Parser + dry-run resolver for the historical "ROI sheet" (one flattened export of
// marketing requests + their product lines + target pharmacies). This module is PURE:
// it never touches the database. It turns raw sheet rows into grouped request line-items,
// applies the data-quality normalizations the sheet needs, resolves each entity against
// injected lookup maps, recomputes expected ROI with the marketing catalog price, and
// flags every row a human must review before a real import writes anything.
//
// POLICY (owner rule):
//   1. The SYSTEM is the source of truth. When the sheet diverges from the system, keep
//      the system value, never the sheet's. `computedExpectedRoi` (catalog price × qty)
//      is the value to persist; the sheet's ROI number is advisory only.
//   2. A divergence NEVER blocks a request — it is flagged for managers to decide
//      case-by-case. Only true structural impossibilities (no request code, an
//      unresolvable requester, or a fully-blank line) keep a row out of the import.
//
// The actual DB-write importer builds on top of this preview; keeping the resolution and
// flagging logic here (and unit-tested) means the writer can trust the mapping.

import {
  calculateMarketingRoiPreview,
  roundMarketingMoney,
} from "@/lib/marketing-requests/roi";
import { normalizeMarketingLookupKey } from "@/lib/marketing-requests/reference-importer";
import type { MarketingRoiStatus } from "@/lib/marketing-requests/types";

// ---------------------------------------------------------------------------
// Raw shape (matches the 20 sheet columns)
// ---------------------------------------------------------------------------

export type RoiSheetRawRow = {
  view?: number | string | null;
  requestCode?: string | null;
  name?: string | null; // requester login/name (Medical Rep, DM, PM, GPM, …)
  hrId?: string | null;
  contact?: string | null; // doctor / hospital being incentivized
  date?: Date | string | null;
  payDate?: Date | string | null;
  requestType?: string | null;
  duration?: number | string | null;
  roi?: number | string | null; // ROI value recorded on the sheet
  estimatedCost?: number | string | null;
  productName?: string | null;
  productId?: string | null; // sheet product code, e.g. LA001
  qty?: number | string | null;
  distributor?: string | null;
  distributorId?: string | null;
  customerName?: string | null;
  customerCode?: string | null;
  status?: string | null;
  note?: string | null;
};

// ---------------------------------------------------------------------------
// Grouped line-item (one request line = one Date row + its continuation rows)
// ---------------------------------------------------------------------------

export type RoiSheetProductLine = {
  sheetProductCode: string | null;
  sheetProductName: string | null;
  quantity: number;
  sourceRow: number;
};

export type RoiSheetPharmacyLine = {
  rawCustomerCode: string | null;
  matchKey: string | null; // leading zeros stripped, for crosswalk matching
  customerName: string | null;
  distributor: string | null;
  distributorCode: string | null;
  sourceRow: number;
};

export type RoiSheetRequestLine = {
  index: number;
  requestCode: string | null;
  requesterName: string | null;
  hrId: string | null;
  contact: string | null;
  requestDate: Date | null;
  payDate: Date | null;
  // true when requestDate/payDate were recovered from a dd/mm <-> mm/dd misread.
  dateSwapApplied: boolean;
  rawRequestType: string | null;
  durationMonths: number | null;
  sheetRoi: number;
  estimatedCost: number;
  rawStatus: string | null;
  note: string | null;
  products: RoiSheetProductLine[];
  pharmacies: RoiSheetPharmacyLine[];
  headerRow: number;
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Format a date as yyyy-mm-dd using LOCAL components (avoids the UTC off-by-one shift).
function isoDate(date: Date | null): string | null {
  if (!date) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Swap a date's month and day (e.g. 2026-11-05 -> 2026-05-11). Only possible when the
// current day is itself a valid month number (<= 12); otherwise the date is unambiguous
// and cannot have been the victim of a dd/mm <-> mm/dd misread, so we return null.
function swapMonthDay(date: Date): Date | null {
  const month = date.getMonth() + 1; // 1..12
  const day = date.getDate();
  if (day > 12) return null;
  return new Date(date.getFullYear(), day - 1, month, date.getHours(), date.getMinutes());
}

// The source sheet was typed in dd/mm (Egyptian) format but some cells were recorded with
// day and month swapped, which shows up as a pay date BEFORE its request date. A pay date
// can never precede the request, so when we see that anomaly we recover the intended dates
// by swapping month/day on whichever side fixes it (request first, then pay, then both).
// We ONLY touch rows that actually violate pay >= request — a blind global swap would
// corrupt the many already-correct ambiguous dates (verified against the data). Rows that
// stay anomalous after every swap attempt are genuine source typos, left for manual review.
export function recoverSwappedDates(
  requestDate: Date | null,
  payDate: Date | null,
): { requestDate: Date | null; payDate: Date | null; dateSwapApplied: boolean } {
  if (!requestDate || !payDate || payDate.getTime() >= requestDate.getTime()) {
    return { requestDate, payDate, dateSwapApplied: false };
  }
  const swappedRequest = swapMonthDay(requestDate);
  const swappedPay = swapMonthDay(payDate);
  if (swappedRequest && payDate.getTime() >= swappedRequest.getTime()) {
    return { requestDate: swappedRequest, payDate, dateSwapApplied: true };
  }
  if (swappedPay && swappedPay.getTime() >= requestDate.getTime()) {
    return { requestDate, payDate: swappedPay, dateSwapApplied: true };
  }
  if (swappedRequest && swappedPay && swappedPay.getTime() >= swappedRequest.getTime()) {
    return { requestDate: swappedRequest, payDate: swappedPay, dateSwapApplied: true };
  }
  return { requestDate, payDate, dateSwapApplied: false };
}

// A customer code may arrive zero-padded ("0001569882") or as a plain number
// ("429182" / 429182.0). Keep the raw value but expose a match key with leading
// zeros and a trailing ".0" removed so it can join the distributor crosswalk.
export function normalizeCustomerCode(value: unknown): {
  raw: string | null;
  matchKey: string | null;
} {
  let raw = String(value ?? "").trim();
  if (!raw) return { raw: null, matchKey: null };
  if (raw.endsWith(".0")) raw = raw.slice(0, -2);
  const stripped = raw.replace(/^0+/, "");
  // Only treat as a code-match key when it is numeric-ish; Arabic text in this
  // column is junk data that must not be matched as a code.
  const matchKey = /^[A-Za-z0-9]+$/.test(raw) ? (stripped || raw) : null;
  return { raw, matchKey };
}

// Sheet product NAMES that do not match the marketing catalog by name. Most products
// resolve by code (productByCode below); this map only covers the name fallback used when
// a row has no usable code. Map the sheet spelling to the catalog's normalized name.
export const ROI_SHEET_PRODUCT_NAME_ALIASES: Record<string, string> = {
  saginkgo: "saginko",
  "royafloxacin 500 tab": "royafloxacin",
};

export function aliasProductLookupKey(name: string | null): string | null {
  if (!name) return null;
  const key = normalizeMarketingLookupKey(name);
  return ROI_SHEET_PRODUCT_NAME_ALIASES[key] ?? key;
}

// Sheet distributor labels vs the marketing_distributors registry's normalized names.
// e.g. sheet "IBNSINA" -> registry "ibn sina"; sheet "EPDA Lacto" -> registry "epda".
export const ROI_SHEET_DISTRIBUTOR_NAME_ALIASES: Record<string, string> = {
  ibnsina: "ibn sina",
  "epda lacto": "epda",
  "epda lacto warehouse": "epda",
  // Marketing's POS distributor was aligned to the Source-of-Sales name "overseas"
  // (Pharma Overseas) so the actual-sales bridge matches.
  pos: "overseas",
};

export function aliasDistributorLookupKey(name: string | null): string | null {
  if (!name) return null;
  const key = normalizeMarketingLookupKey(name);
  return ROI_SHEET_DISTRIBUTOR_NAME_ALIASES[key] ?? key;
}

// The sheet's Distributor_ID (PS/IS/EP/SF/RM/EG/CP) is the system's canonical distributor
// reference. Map each to the marketing_distributors registry's normalized name. This is the
// PRIMARY distributor resolver (the free-text name is only a fallback) — keep it COMPLETE:
// if a new code appears, add it here rather than letting a pharmacy go unlinked.
export const DISTRIBUTOR_ID_TO_REGISTRY_NAME: Record<string, string> = {
  ps: "overseas", // marketing POS distributor aligned to Source-of-Sales "overseas"
  is: "ibn sina",
  ep: "epda",
  sf: "sofico",
  rm: "ramco",
  eg: "egd",
  cp: "chimipharm",
};

// Resolve a pharmacy's distributor to a registry normalized name: prefer the Distributor_ID
// code, fall back to the free-text distributor name (aliased).
export function resolveDistributorRegistryName(
  distributorCode: string | null,
  distributorName: string | null,
): string | null {
  if (distributorCode) {
    const codeKey = normalizeMarketingLookupKey(distributorCode);
    if (DISTRIBUTOR_ID_TO_REGISTRY_NAME[codeKey]) return DISTRIBUTOR_ID_TO_REGISTRY_NAME[codeKey];
  }
  return aliasDistributorLookupKey(distributorName);
}

// Sheet status label -> coarse marketing request status for historical backfill.
// Intermediate "Approved By X" steps are still in-flight (pending_approval); only
// the final GM sign-off is treated as fully approved.
const STATUS_LABEL_MAP: Record<string, MarketingRequestStatusLike> = {
  pending: "pending_approval",
  declined: "rejected",
  rejected: "rejected",
  "approved by sfe": "pending_approval",
  "approved by sales manager": "pending_approval",
  "approved by marketing": "pending_approval",
  "approved by gm": "approved",
  "approved by ceo": "approved",
};

type MarketingRequestStatusLike =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected";

export function mapSheetStatus(rawStatus: string | null): MarketingRequestStatusLike {
  if (!rawStatus) return "draft";
  return STATUS_LABEL_MAP[normalizeMarketingLookupKey(rawStatus)] ?? "draft";
}

// Sheet request-type label -> marketing_request_types.code
const REQUEST_TYPE_MAP: Record<string, string> = {
  "special request": "special_request",
  deal: "deal",
  conference: "conference",
  rtd: "rtd",
  "hospital group meeting": "hospital_group_meeting",
};

export function mapSheetRequestType(rawType: string | null): string {
  if (!rawType) return "other";
  return REQUEST_TYPE_MAP[normalizeMarketingLookupKey(rawType)] ?? "other";
}

// ---------------------------------------------------------------------------
// Grouping: raw rows -> request line-items
// ---------------------------------------------------------------------------

// A new line-item starts on every row that carries a request Date. Subsequent
// rows without a Date are continuation rows: their products and pharmacies belong
// to the line-item above them.
export function parseRoiSheetRows(rows: RoiSheetRawRow[]): RoiSheetRequestLine[] {
  const lines: RoiSheetRequestLine[] = [];
  let current: RoiSheetRequestLine | null = null;

  rows.forEach((row, offset) => {
    const sourceRow = offset + 2; // +1 for header row, +1 for 1-based Excel rows
    const requestDate = toDate(row.date ?? null);
    const isHeader = requestDate !== null;

    const productCode = cleanText(row.productId);
    const productName = cleanText(row.productName);
    const quantity = toNumber(row.qty);
    const { raw: rawCustomerCode, matchKey } = normalizeCustomerCode(row.customerCode);
    const customerName = cleanText(row.customerName);
    const distributor = cleanText(row.distributor);
    const distributorCode = cleanText(row.distributorId);

    if (isHeader) {
      const recovered = recoverSwappedDates(requestDate, toDate(row.payDate ?? null));
      current = {
        index: lines.length,
        requestCode: cleanText(row.requestCode),
        requesterName: cleanText(row.name),
        hrId: cleanText(row.hrId),
        contact: cleanText(row.contact),
        requestDate: recovered.requestDate,
        payDate: recovered.payDate,
        dateSwapApplied: recovered.dateSwapApplied,
        rawRequestType: cleanText(row.requestType),
        durationMonths: toOptionalNumber(row.duration),
        sheetRoi: toNumber(row.roi),
        estimatedCost: toNumber(row.estimatedCost),
        rawStatus: cleanText(row.status),
        note: cleanText(row.note),
        products: [],
        pharmacies: [],
        headerRow: sourceRow,
      };
      lines.push(current);
    }

    if (!current) return; // continuation row before any header (should not happen)

    if (productCode || (productName && quantity > 0)) {
      current.products.push({
        sheetProductCode: productCode,
        sheetProductName: productName,
        quantity,
        sourceRow,
      });
    }
    if (rawCustomerCode || customerName) {
      current.pharmacies.push({
        rawCustomerCode,
        matchKey,
        customerName,
        distributor,
        distributorCode,
        sourceRow,
      });
    }
  });

  return lines;
}

// ---------------------------------------------------------------------------
// Resolution + dry-run preview
// ---------------------------------------------------------------------------

export type RoiImportLookups = {
  // sheet product code (e.g. "RO001", uppercased) -> marketing { id, factoryPrice }.
  // Preferred bridge: the sheet's Product_ID is clean even when its Product(s) name is not.
  productByCode: Map<string, { id: number; factoryPrice: number }>;
  // normalized product name (post-alias) -> { id, factoryPrice }. Fallback when no code.
  productByName: Map<string, { id: number; factoryPrice: number }>;
  // request-type code -> id
  requestTypeIdByCode: Map<string, number>;
  // uppercased HR_ID -> true (exists in employees)
  employeeHrIds: Set<string>;
  // leading-zero-stripped pharmacy code -> true (resolvable via crosswalk)
  knownPharmacyCodes: Set<string>;
};

export type RoiImportFlag =
  | "missing_request_code"
  | "unknown_requester"
  | "junk_row"
  | "no_products"
  | "unmapped_request_type"
  | "unresolved_product"
  | "unresolved_pharmacy"
  | "pay_before_request_date"
  | "date_swap_applied"
  | "roi_mismatch";

export type RoiImportPreviewLine = {
  index: number;
  requestCode: string | null;
  hrId: string | null;
  requesterName: string | null;
  contact: string | null;
  mappedStatus: MarketingRequestStatusLike;
  mappedRequestTypeCode: string;
  requestDate: string | null; // ISO yyyy-mm-dd, after dd/mm recovery
  payDate: string | null; // ISO yyyy-mm-dd, after dd/mm recovery
  estimatedCost: number;
  sheetRoi: number;
  computedExpectedRoi: number;
  requiredRoi: number;
  roiStatus: MarketingRoiStatus;
  productCount: number;
  pharmacyCount: number;
  unresolvedProducts: string[];
  unresolvedPharmacyCount: number;
  flags: RoiImportFlag[];
};

export type RoiImportPreview = {
  lines: RoiImportPreviewLine[];
  summary: {
    totalLines: number;
    importable: number; // no blocking flags
    flagged: number;
    distinctRequestCodes: number;
    distinctRequesters: number;
    totalEstimatedCost: number;
    totalComputedRoi: number;
    coversRequired: number;
    underTarget: number;
    flagCounts: Record<RoiImportFlag, number>;
  };
};

// Per the owner policy, a divergence never blocks a request — it is flagged for manager
// review. Only true structural impossibilities keep a row out of the import: a request
// with no code, a requester that does not exist (FK cannot be satisfied), or a blank line.
// `no_products`, `unresolved_product`, `roi_mismatch`, `unresolved_pharmacy`,
// `pay_before_request_date`, `date_swap_applied`, and `unmapped_request_type` are all
// ADVISORY: the row still imports (using system source-of-truth values), flagged for review.
const BLOCKING_FLAGS: ReadonlySet<RoiImportFlag> = new Set<RoiImportFlag>([
  "missing_request_code",
  "unknown_requester",
  "junk_row",
]);

function emptyFlagCounts(): Record<RoiImportFlag, number> {
  return {
    missing_request_code: 0,
    unknown_requester: 0,
    junk_row: 0,
    no_products: 0,
    unmapped_request_type: 0,
    unresolved_product: 0,
    unresolved_pharmacy: 0,
    pay_before_request_date: 0,
    date_swap_applied: 0,
    roi_mismatch: 0,
  };
}

export function buildRoiImportPreview(
  lines: RoiSheetRequestLine[],
  lookups: RoiImportLookups,
): RoiImportPreview {
  const previewLines: RoiImportPreviewLine[] = [];
  const flagCounts = emptyFlagCounts();
  const requestCodes = new Set<string>();
  const requesters = new Set<string>();

  let importable = 0;
  let totalEstimatedCost = 0;
  let totalComputedRoi = 0;
  let coversRequired = 0;
  let underTarget = 0;

  for (const line of lines) {
    const flags: RoiImportFlag[] = [];
    const mappedRequestTypeCode = mapSheetRequestType(line.rawRequestType);
    const mappedStatus = mapSheetStatus(line.rawStatus);

    if (!line.requestCode) flags.push("missing_request_code");
    if (!line.hrId || !lookups.employeeHrIds.has(line.hrId.toUpperCase())) {
      flags.push("unknown_requester");
    }
    if (line.estimatedCost === 0 && line.sheetRoi === 0 && line.products.length === 0) {
      flags.push("junk_row");
    }
    if (!lookups.requestTypeIdByCode.has(mappedRequestTypeCode)) {
      flags.push("unmapped_request_type");
    }

    // Resolve products + recompute expected ROI with the marketing catalog price.
    const unresolvedProducts: string[] = [];
    const roiProducts = line.products.map((product) => {
      const code = product.sheetProductCode ? product.sheetProductCode.toUpperCase() : null;
      const nameKey = aliasProductLookupKey(product.sheetProductName ?? product.sheetProductCode);
      const match =
        (code ? lookups.productByCode.get(code) : undefined) ??
        (nameKey ? lookups.productByName.get(nameKey) : undefined);
      if (!match) {
        const label = product.sheetProductName ?? product.sheetProductCode ?? "(blank)";
        if (!unresolvedProducts.includes(label)) unresolvedProducts.push(label);
      }
      return {
        productId: match?.id ?? null,
        factoryPrice: match?.factoryPrice ?? 0,
        quantity: product.quantity,
      };
    });

    if (line.products.length === 0) flags.push("no_products");
    if (unresolvedProducts.length > 0) flags.push("unresolved_product");

    const roiPreview = calculateMarketingRoiPreview({
      estimatedCost: line.estimatedCost,
      products: roiProducts,
    });

    // ROI divergence check. `computed` (system catalog price × qty) is authoritative and
    // is the value the importer persists; the sheet's recorded ROI is advisory. When they
    // disagree we raise an ADVISORY flag for a manager — it never blocks the request.
    const sheetRoi = roundMarketingMoney(line.sheetRoi);
    const computed = roiPreview.expectedRoiValue;
    if (line.products.length > 0 && unresolvedProducts.length === 0 && sheetRoi > 0) {
      const diff = Math.abs(computed - sheetRoi);
      const rel = sheetRoi > 0 ? diff / sheetRoi : 0;
      if (diff > 2 && rel > 0.005) flags.push("roi_mismatch");
    }

    // Pharmacy resolution (non-blocking: unmatched pharmacies import as pending).
    let unresolvedPharmacyCount = 0;
    for (const pharmacy of line.pharmacies) {
      if (!pharmacy.matchKey || !lookups.knownPharmacyCodes.has(pharmacy.matchKey)) {
        unresolvedPharmacyCount += 1;
      }
    }
    if (unresolvedPharmacyCount > 0) flags.push("unresolved_pharmacy");

    // Dates already had the dd/mm misread recovered in the parser. Surface that an
    // auto-correction happened (advisory/audit), and only flag pay_before_request_date
    // for rows that STILL violate pay >= request after every swap attempt (genuine typos).
    if (line.dateSwapApplied) flags.push("date_swap_applied");
    if (
      line.requestDate &&
      line.payDate &&
      line.payDate.getTime() < line.requestDate.getTime()
    ) {
      flags.push("pay_before_request_date");
    }

    for (const flag of flags) flagCounts[flag] += 1;
    const isImportable = !flags.some((flag) => BLOCKING_FLAGS.has(flag));
    if (isImportable) importable += 1;

    if (line.requestCode) requestCodes.add(line.requestCode);
    if (line.hrId) requesters.add(line.hrId.toUpperCase());
    totalEstimatedCost += line.estimatedCost;
    totalComputedRoi += computed;
    if (roiPreview.roiStatus === "covers_required") coversRequired += 1;
    if (roiPreview.roiStatus === "under_target") underTarget += 1;

    previewLines.push({
      index: line.index,
      requestCode: line.requestCode,
      hrId: line.hrId,
      requesterName: line.requesterName,
      contact: line.contact,
      mappedStatus,
      mappedRequestTypeCode,
      requestDate: isoDate(line.requestDate),
      payDate: isoDate(line.payDate),
      estimatedCost: line.estimatedCost,
      sheetRoi,
      computedExpectedRoi: computed,
      requiredRoi: roiPreview.requiredRoiValue,
      roiStatus: roiPreview.roiStatus,
      productCount: line.products.length,
      pharmacyCount: line.pharmacies.length,
      unresolvedProducts,
      unresolvedPharmacyCount,
      flags,
    });
  }

  return {
    lines: previewLines,
    summary: {
      totalLines: previewLines.length,
      importable,
      flagged: previewLines.length - importable,
      distinctRequestCodes: requestCodes.size,
      distinctRequesters: requesters.size,
      totalEstimatedCost: roundMarketingMoney(totalEstimatedCost),
      totalComputedRoi: roundMarketingMoney(totalComputedRoi),
      coversRequired,
      underTarget,
      flagCounts,
    },
  };
}
