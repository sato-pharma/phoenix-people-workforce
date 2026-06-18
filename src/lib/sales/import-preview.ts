import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

// ─────────────────────────────────────────────────────────────────────────────
// Source of Sales — dry-run import preview diff (PURE, no I/O, unit-tested).
//
// Given the coded rows the importer WOULD write, the validation issues it raised, and the customer
// → brick mapping currently stored, this summarizes "what will happen" before anything is persisted:
//   • how much of the file resolves (rows + value),
//   • which customers are NEW (present in the file but not yet in the mapping sheet — these are the
//     ones that block, since the mapping sheet is the sole source of truth for a customer's brick),
//   • which products are unmapped,
//   • brick DRIFT — customers whose resolved brick differs from the stored mapping (always 0 on the
//     pure-normalizer path, since it resolves straight from the map; non-zero only catches a
//     coded/hybrid sheet carrying a stale brick).
//
// The caller (service layer) does the I/O: it loads the stored map (listCustomerMap) and builds
// `existingBrickByKey`, then passes the rows/issues from whichever import path ran.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_CAP = 50;

export type ImportPreviewRow = {
  brickId: string | null;
  clientCode: string | null;
  value: number;
};

export type ImportPreviewIssue = {
  field: string;
  value: string | null;
};

export type ImportPreviewBrickDrift = {
  customerCode: string;
  mappedBrickId: string;
  resolvedBrickId: string;
};

export type ImportPreviewDiff = {
  brickDriftCount: number;
  brickDriftSamples: ImportPreviewBrickDrift[];
  distinctCustomers: number;
  importableRows: number;
  importableValue: number;
  mappedCustomers: number;
  newCustomerCodes: string[];
  newCustomers: number;
  resolvedRowsPct: number; // 0..100, rounded to 1 dp
  totalRows: number;
  unmappedProducts: string[];
  unmappedProductsCount: number;
};

/** Composite map key — MUST match crosswalks.ts (`${DIST} ${CODE}`, both normalizeCodeKey'd). */
export function customerMapKey(distributorCode: string, customerCode: string): string {
  return `${normalizeCodeKey(distributorCode)} ${normalizeCodeKey(customerCode)}`;
}

function roundPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

export function buildImportPreviewDiff(input: {
  distributorCode: string;
  existingBrickByKey: Map<string, string>;
  importableRows: number;
  issues: ImportPreviewIssue[];
  rows: ImportPreviewRow[];
  totalRows: number;
}): ImportPreviewDiff {
  const { distributorCode, existingBrickByKey, importableRows, issues, rows, totalRows } = input;

  // Distinct customers present in the file: coded-row client codes ∪ unmapped (Territory) issue values.
  // Keyed by the canonical composite key so case/spacing never double-counts.
  const fileCustomerByKey = new Map<string, string>(); // key -> display code (first seen)
  const addCustomer = (rawCode: string | null | undefined) => {
    const code = String(rawCode ?? "").trim();
    if (!code) return;
    const key = customerMapKey(distributorCode, code);
    if (!fileCustomerByKey.has(key)) fileCustomerByKey.set(key, code);
  };
  for (const row of rows) addCustomer(row.clientCode);
  for (const issue of issues) {
    // Only a pure Territory/Brick issue carries a customer code as its value. A combined
    // "Product & Territory" issue's value is the product label (rawItem first), so it's excluded here.
    if (/^(territory|brick)/i.test(issue.field)) addCustomer(issue.value);
  }

  // New vs mapped (the mapping sheet is the source of truth — "new" = needs mapping).
  const newCustomerCodes: string[] = [];
  let mappedCustomers = 0;
  for (const [key, code] of fileCustomerByKey) {
    if (existingBrickByKey.has(key)) mappedCustomers += 1;
    else if (newCustomerCodes.length < SAMPLE_CAP) newCustomerCodes.push(code); // overflow still counted below
  }
  const newCustomers = fileCustomerByKey.size - mappedCustomers;

  // Brick drift — coded rows whose resolved brick differs from the stored mapping for that customer.
  const driftSeen = new Set<string>();
  const brickDriftSamples: ImportPreviewBrickDrift[] = [];
  let brickDriftCount = 0;
  for (const row of rows) {
    const code = String(row.clientCode ?? "").trim();
    const resolved = String(row.brickId ?? "").trim();
    if (!code || !resolved) continue;
    const key = customerMapKey(distributorCode, code);
    const mapped = existingBrickByKey.get(key);
    if (!mapped || mapped === resolved) continue;
    if (driftSeen.has(key)) continue;
    driftSeen.add(key);
    brickDriftCount += 1;
    if (brickDriftSamples.length < SAMPLE_CAP) {
      brickDriftSamples.push({ customerCode: code, mappedBrickId: mapped, resolvedBrickId: resolved });
    }
  }

  // Unmapped products — distinct values from product-reason issues.
  const productSeen = new Set<string>();
  const unmappedProducts: string[] = [];
  for (const issue of issues) {
    if (!/product/i.test(issue.field)) continue;
    const label = String(issue.value ?? "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (productSeen.has(key)) continue;
    productSeen.add(key);
    if (unmappedProducts.length < SAMPLE_CAP) unmappedProducts.push(label);
  }

  const importableValue = rows.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  const resolvedRowsPct = totalRows > 0 ? roundPct((importableRows / totalRows) * 100) : 0;

  return {
    brickDriftCount,
    brickDriftSamples,
    distinctCustomers: fileCustomerByKey.size,
    importableRows,
    importableValue: Math.round(importableValue * 100) / 100,
    mappedCustomers,
    newCustomerCodes,
    newCustomers,
    resolvedRowsPct,
    totalRows,
    unmappedProducts,
    unmappedProductsCount: productSeen.size,
  };
}
