// Bulk upload service for importing historical marketing requests from XLSX.
// Produces a downloadable template and accepts filled uploads. Each uploaded row
// is validated, resolved against live DB lookups, and written exactly as the system
// would write it — same request code format, same approval step structure, same ROI
// computations — only bypassing the interactive workflow so historical records can be
// back-filled in bulk. Only Super Admin users may execute the import.

import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";

import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";
import { normalizeMarketingLookupKey } from "@/lib/marketing-requests/reference-importer";
import { resolveStoredEmployeeHrId } from "@/lib/marketing-requests/service";
import { DISTRIBUTOR_ID_TO_REGISTRY_NAME } from "@/lib/marketing-requests/roi-sheet-import";
import { calculateMarketingRoiPreview, roundMarketingMoney } from "@/lib/marketing-requests/roi";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PRODUCTS = 5;
const MAX_PHARMACIES = 3;

const REQUEST_TYPE_OPTIONS = [
  "special_request",
  "deal",
  "conference",
  "rtd",
  "hospital_group_meeting",
  "other",
] as const;

const IMPORT_STATUS_OPTIONS = ["approved", "pending_approval"] as const;
type ImportStatus = (typeof IMPORT_STATUS_OPTIONS)[number];

const DISTRIBUTOR_CODE_OPTIONS = Object.keys(DISTRIBUTOR_ID_TO_REGISTRY_NAME).map((k) => k.toUpperCase());

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type BulkUploadRow = {
  requestCode: string | null;
  requesterHrId: string | null;
  requestDate: string | null;
  payDate: string | null;
  requestType: string | null;
  otherTypeDescription: string | null;
  roiDurationMonths: number;
  estimatedCost: number;
  customerCode: string | null;
  expectedRoiValueOverride: number | null;
  products: Array<{ code: string | null; qty: number }>;
  pharmacies: Array<{ vendorCode: string | null; distributorCode: string | null }>;
  notes: string | null;
  importStatus: ImportStatus;
  rowIndex: number;
};

export type BulkImportPreviewRow = BulkUploadRow & {
  resolvedCustomerId: string | null;
  resolvedProducts: Array<{
    productId: number | null;
    productCode: string | null;
    productName: string;
    factoryPrice: number;
    qty: number;
    expectedValue: number;
  }>;
  resolvedPharmacies: Array<{
    distributorCodeId: string | null;
    vendorCode: string | null;
    distributorShortCode: string | null;
  }>;
  mappedRequestTypeCode: string;
  requestTypeId: number | null;
  computedExpectedRoi: number;
  requiredRoi: number;
  roiStatus: "not_calculated" | "covers_required" | "under_target";
  errors: string[];
  warnings: string[];
  canImport: boolean;
};

export type BulkImportPreview = {
  rows: BulkImportPreviewRow[];
  summary: {
    total: number;
    canImport: number;
    hasErrors: number;
    hasWarnings: number;
    totalEstimatedCost: number;
    totalComputedRoi: number;
  };
};

export type BulkImportResultRow = {
  rowIndex: number;
  requestCode: string;
  requesterHrId: string;
  success: boolean;
  error: string | null;
};

export type BulkImportResult = {
  imported: number;
  failed: number;
  rows: BulkImportResultRow[];
};

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

export async function generateBulkUploadTemplate(access: AccessContext): Promise<ArrayBuffer> {
  // Same gate as preview/execute — the template is only reachable from the Super-Admin-only
  // bulk-upload page, so a non-Super-Admin fetching it is never a legitimate call.
  if (!canAccessSystemAdministratorWorkspace(access)) {
    throw forbiddenError("Only Super Admin users can download the bulk import template.");
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";

  // ── Sheet 1: Data ──────────────────────────────────────────────────────────
  const ws = wb.addWorksheet("Marketing Requests", { views: [{ state: "frozen", ySplit: 2 }] });

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0369A1" } },
    alignment: { vertical: "middle", wrapText: true },
    border: {
      bottom: { style: "thin", color: { argb: "FF075985" } },
    },
  };
  const noteStyle: Partial<ExcelJS.Style> = {
    font: { italic: true, color: { argb: "FF64748B" }, size: 9 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F9FF" } },
    alignment: { vertical: "middle", wrapText: true },
  };
  const sampleStyle: Partial<ExcelJS.Style> = {
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } },
    font: { color: { argb: "FF166534" }, size: 9 },
  };

  interface ColDef {
    header: string;
    note: string;
    width: number;
    numFmt?: string;
    validation?: ExcelJS.DataValidation;
  }

  const columns: ColDef[] = [
    { header: "Request Code", note: "Leave blank — auto-generated as MKT-REQ-YYYYMMDD-XXXX", width: 28 },
    { header: "Requester HR ID *", note: "Employee HR ID (e.g. A001). Must exist in the system.", width: 18 },
    { header: "Request Date *", note: "Format: YYYY-MM-DD", width: 14 },
    { header: "Pay Date", note: "Format: YYYY-MM-DD (optional)", width: 14 },
    {
      header: "Request Type *",
      note: "Pick from list →",
      width: 22,
      validation: {
        type: "list",
        allowBlank: false,
        formulae: [`"${REQUEST_TYPE_OPTIONS.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Invalid",
        error: `Must be one of: ${REQUEST_TYPE_OPTIONS.join(", ")}`,
      },
    },
    { header: "Other Type Description", note: "Required only when Request Type = other", width: 24 },
    {
      header: "ROI Duration (Months)",
      note: "Whole number, default: 1",
      width: 18,
      numFmt: "0",
      validation: {
        type: "whole",
        operator: "greaterThan",
        formulae: [0],
        allowBlank: true,
        showErrorMessage: true,
        errorTitle: "Invalid",
        error: "Must be a positive whole number",
      },
    },
    {
      header: "Estimated Cost (EGP) *",
      note: "Numeric, e.g. 5000",
      width: 20,
      numFmt: "#,##0.00",
      validation: {
        type: "decimal",
        operator: "greaterThanOrEqual",
        formulae: [0],
        allowBlank: false,
        showErrorMessage: true,
        errorTitle: "Invalid",
        error: "Must be a non-negative number",
      },
    },
    { header: "Customer Code *", note: "marketing_customers.customer_code (e.g. MKT-HCP-...)", width: 30 },
    {
      header: "Expected ROI Value (EGP)",
      note: "Optional — computed from products if blank",
      width: 22,
      numFmt: "#,##0.00",
    },
    // Products
    ...Array.from({ length: MAX_PRODUCTS }, (_, i): ColDef[] => [
      { header: `Product ${i + 1} Code`, note: i === 0 ? "Product code (e.g. LA001)" : "", width: 16 },
      { header: `Product ${i + 1} Qty`, note: i === 0 ? "Forecast quantity" : "", width: 14, numFmt: "0" },
    ]).flat(),
    // Pharmacies
    ...Array.from({ length: MAX_PHARMACIES }, (_, i): ColDef[] => [
      { header: `Pharmacy ${i + 1} Vendor Code`, note: i === 0 ? "Vendor/distributor pharmacy code" : "", width: 22 },
      {
        header: `Pharmacy ${i + 1} Distributor`,
        note: i === 0 ? `Short code: ${DISTRIBUTOR_CODE_OPTIONS.join("/")}` : "",
        width: 20,
        validation: i === 0 ? {
          type: "list",
          allowBlank: true,
          formulae: [`"${DISTRIBUTOR_CODE_OPTIONS.join(",")}"`],
          showErrorMessage: true,
          errorTitle: "Invalid",
          error: `Must be one of: ${DISTRIBUTOR_CODE_OPTIONS.join(", ")}`,
        } : undefined,
      },
    ]).flat(),
    { header: "Notes", note: "Optional internal notes", width: 28 },
    {
      header: "Import Status *",
      note: "approved = historical approved record; pending_approval = start new workflow",
      width: 22,
      validation: {
        type: "list",
        allowBlank: false,
        formulae: [`"${IMPORT_STATUS_OPTIONS.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Invalid",
        error: `Must be one of: ${IMPORT_STATUS_OPTIONS.join(", ")}`,
      },
    },
  ];

  ws.columns = columns.map((c, i) => ({
    key: `col${i}`,
    width: c.width,
    style: c.numFmt ? { numFmt: c.numFmt } : undefined,
  }));

  // Row 1: headers
  const headerRow = ws.getRow(1);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    Object.assign(cell, { style: headerStyle });
  });
  headerRow.height = 28;

  // Row 2: notes / guidance
  const noteRow = ws.getRow(2);
  columns.forEach((col, i) => {
    const cell = noteRow.getCell(i + 1);
    cell.value = col.note;
    Object.assign(cell, { style: noteStyle });
  });
  noteRow.height = 36;

  // Row 3: sample data
  const sampleRow = ws.getRow(3);
  const totalCols = 10 + MAX_PRODUCTS * 2 + MAX_PHARMACIES * 2 + 2;
  const sampleValues: (string | number)[] = [
    "",            // request_code (blank = auto)
    "A001",        // requester_hr_id
    "2026-01-15",  // request_date
    "2026-02-15",  // pay_date
    "special_request", // request_type
    "",            // other_type_description
    1,             // roi_duration_months
    5000,          // estimated_cost
    "MKT-HCP-20260101-ABCD1234", // customer_code
    "",            // expected_roi_value (computed)
    "LA001", 100,  // product 1
    "", 0,         // product 2
    "", 0,         // product 3
    "", 0,         // product 4
    "", 0,         // product 5
    "123456", "IS", // pharmacy 1
    "", "",         // pharmacy 2
    "", "",         // pharmacy 3
    "Historical import",  // notes
    "approved",    // import_status
  ];
  sampleValues.slice(0, totalCols).forEach((val, i) => {
    const cell = sampleRow.getCell(i + 1);
    cell.value = val === "" ? null : val;
    Object.assign(cell, { style: sampleStyle });
  });
  sampleRow.height = 20;

  // Apply data validations to data rows (3 onward)
  columns.forEach((col, i) => {
    if (col.validation) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws as any).dataValidations.add(
        `${colLetter(i + 1)}3:${colLetter(i + 1)}5000`,
        col.validation,
      );
    }
  });

  // ── Sheet 2: Reference ────────────────────────────────────────────────────
  const ref = wb.addWorksheet("Reference");
  ref.columns = [
    { key: "a", width: 28 },
    { key: "b", width: 40 },
  ];

  const refHeader: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } },
  };

  function refSection(title: string, rows: [string, string][]) {
    const h = ref.addRow([title, ""]);
    h.getCell(1).style = refHeader;
    h.getCell(2).style = refHeader;
    for (const [a, b] of rows) ref.addRow([a, b]);
    ref.addRow([]);
  }

  refSection("Request Types", [
    ["special_request", "Special Request"],
    ["deal", "Deal"],
    ["conference", "Conference"],
    ["rtd", "RTD"],
    ["hospital_group_meeting", "Hospital Group Meeting"],
    ["other", "Other (fill Other Type Description)"],
  ]);

  refSection("Distributor Codes", [
    ["PS", "Pharma Overseas (POS)"],
    ["IS", "Ibn Sina"],
    ["EP", "EPDA"],
    ["SF", "Sofico"],
    ["RM", "Ramco"],
    ["EG", "EGD"],
    ["CP", "Chimipharm"],
  ]);

  refSection("Import Status Options", [
    ["approved", "Historical request already approved — imported as final, all steps auto-approved"],
    ["pending_approval", "Start a new approval workflow from this request data"],
  ]);

  refSection("Required Columns", [
    ["Requester HR ID", "Employee HR ID — must exist in the system"],
    ["Request Date", "Date of the original request (YYYY-MM-DD)"],
    ["Request Type", "One of the request types listed above"],
    ["Estimated Cost (EGP)", "Numeric cost in EGP"],
    ["Customer Code", "Customer code from the marketing customer database"],
    ["Product 1 Code + Qty", "At least one product with quantity > 0 is required"],
    ["Import Status", "approved or pending_approval"],
  ]);

  refSection("Notes", [
    ["Request Code", "Leave blank — the system will auto-generate one"],
    ["Pay Date", "Date the payment/execution was processed (optional)"],
    ["ROI Duration", "How many months to track ROI (default: 1)"],
    ["Expected ROI Value", "Leave blank — computed from product prices × quantities"],
    ["Pharmacies", "Optional — vendor code + distributor short code pairs"],
    ["Max Products / Row", `${MAX_PRODUCTS} products per request row`],
    ["Max Pharmacies / Row", `${MAX_PHARMACIES} pharmacies per request row`],
  ]);

  return wb.xlsx.writeBuffer();
}

// Convert 1-based column index to Excel letter(s)
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function toStr(val: ExcelJS.CellValue): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).replace(/\s+/g, " ").trim();
  return s || null;
}

function toNum(val: ExcelJS.CellValue): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function toOptionalNum(val: ExcelJS.CellValue): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDateStr(val: ExcelJS.CellValue): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  // Accept YYYY-MM-DD or DD/MM/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

export async function parseBulkUploadFile(buffer: ArrayBuffer): Promise<BulkUploadRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Uploaded file has no worksheets.");

  const rows: BulkUploadRow[] = [];

  ws.eachRow((row: ExcelJS.Row, rowNum: number) => {
    if (rowNum <= 2) return; // skip header + note rows

    const c = (n: number) => row.getCell(n).value;

    // Columns 1-10: core fields
    const requestCode = toStr(c(1));
    const requesterHrId = toStr(c(2))?.toUpperCase() ?? null;
    const requestDate = toDateStr(c(3));
    const payDate = toDateStr(c(4));
    const requestType = toStr(c(5));
    const otherTypeDescription = toStr(c(6));
    const roiDurationMonths = Math.max(1, Math.round(toNum(c(7)) || 1));
    const estimatedCost = toNum(c(8));
    const customerCode = toStr(c(9));
    const expectedRoiValueOverride = toOptionalNum(c(10));

    // Columns 11-20: products (5 × 2 columns)
    const products: BulkUploadRow["products"] = [];
    for (let i = 0; i < MAX_PRODUCTS; i++) {
      const code = toStr(c(11 + i * 2));
      const qty = toNum(c(12 + i * 2));
      if (code || qty > 0) products.push({ code, qty });
    }

    // Columns 21-26: pharmacies (3 × 2 columns)
    const pharmacies: BulkUploadRow["pharmacies"] = [];
    const pharmacyOffset = 10 + MAX_PRODUCTS * 2 + 1;
    for (let i = 0; i < MAX_PHARMACIES; i++) {
      const vendorCode = toStr(c(pharmacyOffset + i * 2));
      const distributorCode = toStr(c(pharmacyOffset + i * 2 + 1))?.toUpperCase() ?? null;
      if (vendorCode || distributorCode) pharmacies.push({ vendorCode, distributorCode });
    }

    const notesOffset = pharmacyOffset + MAX_PHARMACIES * 2;
    const notes = toStr(c(notesOffset));
    const rawStatus = toStr(c(notesOffset + 1))?.toLowerCase();
    const importStatus: ImportStatus =
      rawStatus === "pending_approval" ? "pending_approval" : "approved";

    // Skip rows that are completely empty
    const allEmpty = !requesterHrId && !requestDate && !customerCode && estimatedCost === 0;
    if (allEmpty) return;

    rows.push({
      requestCode,
      requesterHrId,
      requestDate,
      payDate,
      requestType,
      otherTypeDescription,
      roiDurationMonths,
      estimatedCost,
      customerCode,
      expectedRoiValueOverride,
      products: products.filter((p) => (p.code || p.qty > 0)),
      pharmacies: pharmacies.filter((p) => p.vendorCode || p.distributorCode),
      notes,
      importStatus,
      rowIndex: rowNum,
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Preview (dry-run) — resolves all IDs and flags errors/warnings without writing
// ---------------------------------------------------------------------------

type LookupMaps = {
  customerByCode: Map<string, { id: string }>;
  productByCode: Map<string, { id: number; productName: string; factoryPrice: number }>;
  requestTypeByCode: Map<string, { id: number }>;
  distributorByShortCode: Map<string, { id: number }>;
  employeeHrIds: Set<string>;
  // normalized_pharmacy_code -> distributor_id -> distributor_code_id
  pharmacyCodeMap: Map<string, Map<number, string>>;
};

async function loadLookupMaps(): Promise<LookupMaps> {
  const supabase = getSupabaseAdmin();

  const [customers, products, requestTypes, distributors, employees, pharmacyCodes] =
    await Promise.all([
      supabase
        .from("marketing_customers")
        .select("id, customer_code")
        .eq("active", true),
      supabase
        .from("marketing_products")
        .select("id, product_code, product_name, factory_price")
        .eq("active", true),
      supabase
        .from("marketing_request_types")
        .select("id, code")
        .eq("active", true),
      supabase
        .from("marketing_distributors")
        .select("id, distributor_code, normalized_name")
        .eq("active", true),
      supabase
        .from("employees")
        .select("hr_id"),
      supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("id, normalized_pharmacy_code, distributor_id"),
    ]);

  if (customers.error) throw customers.error;
  if (products.error) throw products.error;
  if (requestTypes.error) throw requestTypes.error;
  if (distributors.error) throw distributors.error;
  if (employees.error) throw employees.error;
  if (pharmacyCodes.error) throw pharmacyCodes.error;

  // Build distributor lookup: short code (PS/IS/etc) -> db id
  const distributorByShortCode = new Map<string, { id: number }>();
  const distributorByNormalizedName = new Map<string, { id: number }>();
  for (const d of (distributors.data ?? []) as { id: number; distributor_code: string; normalized_name: string }[]) {
    distributorByNormalizedName.set(d.normalized_name, { id: d.id });
  }
  for (const [shortCode, registryName] of Object.entries(DISTRIBUTOR_ID_TO_REGISTRY_NAME)) {
    const dist = distributorByNormalizedName.get(registryName);
    if (dist) distributorByShortCode.set(shortCode.toUpperCase(), dist);
  }

  // Build pharmacy code map: normalized_pharmacy_code -> distributor_id -> distributor_code_id
  const pharmacyCodeMap = new Map<string, Map<number, string>>();
  for (const pc of (pharmacyCodes.data ?? []) as { id: string; normalized_pharmacy_code: string; distributor_id: number }[]) {
    const normCode = String(pc.normalized_pharmacy_code ?? "").replace(/^0+/, "");
    if (!normCode) continue;
    if (!pharmacyCodeMap.has(normCode)) pharmacyCodeMap.set(normCode, new Map());
    pharmacyCodeMap.get(normCode)!.set(pc.distributor_id, pc.id);
  }

  return {
    customerByCode: new Map(
      (customers.data ?? []).map((c: { id: string; customer_code: string }) => [
        normalizeMarketingLookupKey(c.customer_code),
        { id: c.id },
      ])
    ),
    productByCode: new Map(
      (products.data ?? []).map((p: { id: number; product_code: string; product_name: string; factory_price: number }) => [
        normalizeMarketingLookupKey(p.product_code),
        { id: p.id, productName: p.product_name, factoryPrice: Number(p.factory_price) },
      ])
    ),
    requestTypeByCode: new Map(
      (requestTypes.data ?? []).map((t: { id: number; code: string }) => [t.code, { id: t.id }])
    ),
    distributorByShortCode,
    employeeHrIds: new Set(
      (employees.data ?? []).map((e: { hr_id: string }) => String(e.hr_id ?? "").toUpperCase())
    ),
    pharmacyCodeMap,
  };
}

function resolvePharmacyDistributorCodeId(
  vendorCode: string | null,
  distributorShortCode: string | null,
  lookups: LookupMaps,
): string | null {
  if (!vendorCode) return null;
  const normCode = vendorCode.replace(/^0+/, "").replace(/\.0$/, "");
  if (!normCode) return null;
  const distEntry = distributorShortCode
    ? lookups.distributorByShortCode.get(distributorShortCode.toUpperCase())
    : null;
  if (!distEntry) return null;
  return lookups.pharmacyCodeMap.get(normCode)?.get(distEntry.id) ?? null;
}

function mapRequestTypeCode(rawType: string | null): string {
  if (!rawType) return "other";
  const key = normalizeMarketingLookupKey(rawType);
  if ((REQUEST_TYPE_OPTIONS as readonly string[]).includes(key)) return key;
  // Try mapping common alternatives
  const aliases: Record<string, string> = {
    "special request": "special_request",
    "hospital group meeting": "hospital_group_meeting",
    "hospital meeting": "hospital_group_meeting",
  };
  return aliases[key] ?? (rawType.includes("_") ? rawType.toLowerCase() : "other");
}

function previewRow(row: BulkUploadRow, lookups: LookupMaps): BulkImportPreviewRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Requester
  if (!row.requesterHrId) {
    errors.push("Requester HR ID is required.");
  } else if (!lookups.employeeHrIds.has(row.requesterHrId)) {
    errors.push(`Requester HR ID "${row.requesterHrId}" not found in the system.`);
  }

  // Dates
  if (!row.requestDate) errors.push("Request Date is required (format: YYYY-MM-DD).");
  if (row.requestDate && row.payDate && row.payDate < row.requestDate) {
    warnings.push("Pay Date is before Request Date.");
  }

  // Cost
  if (row.estimatedCost <= 0) errors.push("Estimated Cost must be greater than 0.");

  // Customer
  const customerKey = normalizeMarketingLookupKey(row.customerCode ?? "");
  const customer = customerKey ? lookups.customerByCode.get(customerKey) ?? null : null;
  if (!row.customerCode) {
    errors.push("Customer Code is required.");
  } else if (!customer) {
    errors.push(`Customer with code "${row.customerCode}" not found in the system.`);
  }

  // Request type
  const mappedRequestTypeCode = mapRequestTypeCode(row.requestType);
  const requestTypeEntry = lookups.requestTypeByCode.get(mappedRequestTypeCode);
  if (!requestTypeEntry) {
    warnings.push(`Request type "${row.requestType}" could not be mapped; will use "other".`);
  }
  if (mappedRequestTypeCode === "other" && !row.otherTypeDescription) {
    warnings.push('Other Type Description is recommended when Request Type is "other".');
  }

  // Products
  const resolvedProducts: BulkImportPreviewRow["resolvedProducts"] = [];
  if (row.products.length === 0) {
    errors.push("At least one product with a code and quantity > 0 is required.");
  }
  for (const p of row.products) {
    const pKey = normalizeMarketingLookupKey(p.code ?? "");
    const match = pKey ? lookups.productByCode.get(pKey) ?? null : null;
    if (!match) {
      errors.push(`Product code "${p.code}" not found in the system.`);
      resolvedProducts.push({
        productId: null,
        productCode: p.code,
        productName: p.code ?? "(unknown)",
        factoryPrice: 0,
        qty: p.qty,
        expectedValue: 0,
      });
    } else {
      resolvedProducts.push({
        productId: match.id,
        productCode: p.code,
        productName: match.productName,
        factoryPrice: match.factoryPrice,
        qty: p.qty,
        expectedValue: roundMarketingMoney(match.factoryPrice * p.qty),
      });
    }
    if (p.qty <= 0) errors.push(`Product "${p.code}" has quantity 0 or less.`);
  }

  // Pharmacies
  const resolvedPharmacies: BulkImportPreviewRow["resolvedPharmacies"] = [];
  for (const ph of row.pharmacies) {
    const distributorCodeId = resolvePharmacyDistributorCodeId(
      ph.vendorCode,
      ph.distributorCode,
      lookups,
    );
    if (!distributorCodeId) {
      warnings.push(
        `Pharmacy vendor code "${ph.vendorCode}" (distributor: ${ph.distributorCode}) could not be resolved — will be skipped.`,
      );
    }
    resolvedPharmacies.push({
      distributorCodeId,
      vendorCode: ph.vendorCode,
      distributorShortCode: ph.distributorCode,
    });
  }

  // ROI computation
  const roiPreview = calculateMarketingRoiPreview({
    estimatedCost: row.estimatedCost,
    products: resolvedProducts
      .filter((p) => p.productId !== null)
      .map((p) => ({ productId: p.productId!, factoryPrice: p.factoryPrice, quantity: p.qty })),
  });

  const canImport = errors.length === 0;

  return {
    ...row,
    resolvedCustomerId: customer?.id ?? null,
    resolvedProducts,
    resolvedPharmacies,
    mappedRequestTypeCode,
    requestTypeId: requestTypeEntry?.id ?? null,
    computedExpectedRoi: roiPreview.expectedRoiValue,
    requiredRoi: roiPreview.requiredRoiValue,
    roiStatus: roiPreview.roiStatus,
    errors,
    warnings,
    canImport,
  };
}

/**
 * Preview is NOT a read-only formatting pass — it resolves every uploaded row against live
 * marketing master data and hands back customer ids, distributor-code ids and product rows
 * INCLUDING factoryPrice. It therefore carries the same Super-Admin gate as the execute path:
 * previously it took no AccessContext at all, so any authenticated user of any role could POST
 * a crafted sheet and enumerate the customer / product / pharmacy masters and their pricing.
 */
export async function buildBulkImportPreview(
  rows: BulkUploadRow[],
  access: AccessContext,
): Promise<BulkImportPreview> {
  if (!canAccessSystemAdministratorWorkspace(access)) {
    throw forbiddenError("Only Super Admin users can preview bulk marketing request imports.");
  }

  const lookups = await loadLookupMaps();
  const previewRows = rows.map((row) => previewRow(row, lookups));

  const canImport = previewRows.filter((r) => r.canImport).length;
  const hasErrors = previewRows.filter((r) => r.errors.length > 0).length;
  const hasWarnings = previewRows.filter((r) => r.warnings.length > 0).length;
  const totalEstimatedCost = roundMarketingMoney(
    previewRows.filter((r) => r.canImport).reduce((s, r) => s + r.estimatedCost, 0),
  );
  const totalComputedRoi = roundMarketingMoney(
    previewRows.filter((r) => r.canImport).reduce((s, r) => s + r.computedExpectedRoi, 0),
  );

  return {
    rows: previewRows,
    summary: { total: previewRows.length, canImport, hasErrors, hasWarnings, totalEstimatedCost, totalComputedRoi },
  };
}

// ---------------------------------------------------------------------------
// Execute import
// ---------------------------------------------------------------------------

function generateMarketingCode(prefix: string) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function executeBulkImport(
  rows: BulkUploadRow[],
  access: AccessContext,
): Promise<BulkImportResult> {
  if (!canAccessSystemAdministratorWorkspace(access)) {
    throw forbiddenError("Only Super Admin users can execute bulk marketing request imports.");
  }

  // `access.hrId` is ALWAYS lower-cased (createAccessContext runs it through normalizeHrId,
  // which lower-cases for COMPARISON). marketing_requests.created_by_hr_id / updated_by_hr_id
  // and marketing_request_approval_steps.decision_by_hr_id are case-sensitive FKs to the
  // upper-cased employees(hr_id), so writing the raw value made a Super Admin "B-157" store
  // "b-157" -> FK violation -> import_marketing_request_atomic rolled the whole row back.
  const actorStoredHrId = resolveStoredEmployeeHrId(access.hrId);

  const supabase = getSupabaseAdmin();
  const lookups = await loadLookupMaps();

  // Load all active workflow steps (for approved imports — we mark them all approved)
  const stepsResult = await supabase
    .from("marketing_workflow_steps")
    .select("id, step_code, step_name, sequence, assigned_role, approval_scope, required")
    .eq("active", true)
    .order("sequence");
  if (stepsResult.error) throw stepsResult.error;
  const workflowSteps = (stepsResult.data ?? []) as {
    id: number;
    step_code: string;
    step_name: string;
    sequence: number;
    assigned_role: string;
    approval_scope: string;
    required: boolean;
  }[];

  const results: BulkImportResultRow[] = [];
  let imported = 0;
  let failed = 0;

  for (const row of rows) {
    const resolved = previewRow(row, lookups);
    if (!resolved.canImport) {
      results.push({
        rowIndex: row.rowIndex,
        requestCode: row.requestCode ?? "(none)",
        requesterHrId: row.requesterHrId ?? "(none)",
        success: false,
        error: resolved.errors.join("; "),
      });
      failed++;
      continue;
    }

    try {
      const requestCode = row.requestCode?.trim() || generateMarketingCode("MKT-REQ");
      const now = new Date().toISOString();
      const requestDateTs = row.requestDate ? `${row.requestDate}T00:00:00.000Z` : now;

      const expectedRoiValue = resolved.expectedRoiValueOverride ?? resolved.computedExpectedRoi;
      const roiStatus = resolved.roiStatus;

      // Request row. required_roi_value / roi_coverage_ratio are GENERATED ALWAYS
      // columns — the DB derives them, so they are intentionally not sent.
      const requestPayload = {
        request_code: requestCode,
        requester_hr_id: resolved.requesterHrId,
        customer_id: resolved.resolvedCustomerId,
        request_type_id: resolved.requestTypeId,
        other_request_type: resolved.otherTypeDescription,
        request_date: resolved.requestDate,
        pay_date: resolved.payDate,
        roi_duration_months: resolved.roiDurationMonths,
        estimated_cost: resolved.estimatedCost,
        expected_roi_value: expectedRoiValue,
        roi_status: roiStatus,
        notes: resolved.notes,
        status: resolved.importStatus === "approved" ? "approved" : "pending_approval",
        submitted_at: requestDateTs,
        approved_at: resolved.importStatus === "approved" ? requestDateTs : null,
        created_by_hr_id: actorStoredHrId,
        updated_by_hr_id: actorStoredHrId,
        // Provenance seam: bulk XLSX upload belongs to the Archived module, not the live one.
        origin: "xlsx_import",
      };

      // Product rows. value_share comes from the batch ROI calc across all of the
      // row's products (product expected_value is a GENERATED ALWAYS column).
      const resolvedProducts = resolved.resolvedProducts.filter((p) => p.productId !== null);
      let productPayload: Array<Record<string, unknown>> = [];
      if (resolvedProducts.length > 0) {
        const fullRoi = calculateMarketingRoiPreview({
          estimatedCost: row.estimatedCost,
          products: resolvedProducts.map((p) => ({
            productId: p.productId!,
            factoryPrice: p.factoryPrice,
            quantity: p.qty,
          })),
        });
        productPayload = resolvedProducts.map((p, i) => ({
          product_id: p.productId,
          product_name_snapshot: p.productName,
          factory_price_snapshot: p.factoryPrice,
          forecast_quantity: p.qty,
          value_share: fullRoi.products[i]?.valueShare ?? 0,
        }));
      }

      const pharmacyPayload = resolved.resolvedPharmacies
        .filter((ph) => ph.distributorCodeId !== null)
        .map((ph) => ({
          distributor_code_id: ph.distributorCodeId,
          tracking_status: "pending_validation",
        }));

      const stepPayload = workflowSteps.map((step, idx) => ({
        workflow_step_id: step.id,
        sequence: step.sequence,
        step_code: step.step_code,
        step_name: step.step_name,
        assigned_role: step.assigned_role,
        status: resolved.importStatus === "approved"
          ? "approved"
          : (idx === 0 ? "current" : "pending"),
        decision_at: resolved.importStatus === "approved" ? requestDateTs : null,
        decision_by_hr_id: resolved.importStatus === "approved" ? actorStoredHrId : null,
        decision_note: resolved.importStatus === "approved" ? "Imported via bulk upload" : null,
      }));

      // Atomic per-row insert: request + products + pharmacies + steps all commit
      // together or roll back together. Replaces the old four-insert sequence with
      // best-effort parent-delete cleanup, which could leave partial data if the
      // cleanup delete itself failed.
      const { error: rpcError } = await supabase.rpc("import_marketing_request_atomic", {
        p_request: requestPayload,
        p_products: productPayload,
        p_pharmacies: pharmacyPayload,
        p_steps: stepPayload,
      });
      if (rpcError) throw rpcError;

      results.push({
        rowIndex: row.rowIndex,
        requestCode,
        requesterHrId: resolved.requesterHrId ?? "",
        success: true,
        error: null,
      });
      imported++;
    } catch (err) {
      // No manual cleanup needed: import_marketing_request_atomic is transactional,
      // so a failed row leaves nothing behind.
      results.push({
        rowIndex: row.rowIndex,
        requestCode: row.requestCode ?? "(none)",
        requesterHrId: row.requesterHrId ?? "(none)",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  return { imported, failed, rows: results };
}
