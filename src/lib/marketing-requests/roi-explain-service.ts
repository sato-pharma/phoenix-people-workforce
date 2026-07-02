// ROI Explainability — read-only per-request data layer.
//
// Builds the "Explain ROI / Attribution Details" payload for ONE marketing request. It
// composes the existing, access-gated, confidential-masked View Sales service for the
// summary + attributed ledger, then runs a few small read-only diagnostic SELECTs
// (product bridge, pharmacy presence, distributor rollup, window coverage) and hands the
// counts to the pure classifier. Read-only: SELECTs + the STABLE view-sales RPC only —
// no insert/update/delete, no attribution-algorithm change, no schema/migration.

import type { AccessContext } from "@/lib/auth/permissions";
import { restrictedProductNameSet } from "@/lib/sales/access-scope";
import { roundMarketingMoney } from "@/lib/marketing-requests/roi";
import {
  getMarketingRequestViewSales,
  isRestrictedMarketingProduct,
  monthAdd,
} from "@/lib/marketing-requests/roi-report-service";
import {
  ROI_EXPLAIN_MATCH_REASON,
  classifyRoiExplainReason,
  type MarketingRoiExplain,
  type RoiExplainDistributorFamily,
  type RoiExplainLedgerRow,
  type RoiExplainPharmacy,
  type RoiExplainProduct,
} from "@/lib/marketing-requests/roi-explain";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function lowerTrim(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// Mirror the attribution RPC's client-code normalization: collapse whitespace, trim, lowercase.
function normalizePharmacyCode(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => (value ?? "").trim()).filter((value) => value.length > 0)));
}

/**
 * Read-only ROI explainability for one request. Access + confidential masking are inherited
 * from `getMarketingRequestViewSales` (which throws `Forbidden: …` for out-of-scope viewers).
 */
export async function explainMarketingRequestRoi(
  access: AccessContext,
  requestId: string,
  generatedAtIso: string,
): Promise<MarketingRoiExplain> {
  const cleanId = String(requestId ?? "").trim();
  if (!cleanId) throw new Error("Marketing request id is required.");

  // 1) Gated summary + attributed ledger + targets (access + masking reused, not re-implemented).
  const viewSales = await getMarketingRequestViewSales(access, cleanId, null, null, generatedAtIso);
  const reveal = viewSales.includedRestricted;
  const supabase = getSupabaseAdmin();
  // `reveal` (CEO/Super Admin confidential opt-in) is decided server-side by the view-sales
  // service; we reuse it so this view's product list/bridge masks identically.
  const restrictedNames = await restrictedProductNameSet();

  // 2) Product bridge — does each target product's normalized name resolve to a SoS product?
  const productLinks = await supabase
    .from("marketing_request_products")
    .select("product_id")
    .eq("request_id", cleanId);
  if (productLinks.error) throw productLinks.error;
  const productIds = Array.from(
    new Set(
      ((productLinks.data ?? []) as Array<{ product_id: number | string }>)
        .map((row) => Number(row.product_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
  let productRows: Array<{ product_code?: string | null; product_name?: string | null; normalized_name?: string | null }> = [];
  if (productIds.length > 0) {
    const { data, error } = await supabase
      .from("marketing_products")
      .select("product_code, product_name, normalized_name")
      .in("id", productIds);
    if (error) throw error;
    productRows = (data ?? []) as typeof productRows;
  }

  // SoS product master is a small reference table → build a normalized-name → code index in TS,
  // exactly mirroring the RPC's `lower(btrim(normalized_product_name))` join key.
  const sosProducts = await supabase
    .from("source_of_sales_products")
    .select("product_code, normalized_product_name, factory_price");
  if (sosProducts.error) throw sosProducts.error;
  const sosProductByNorm = new Map<string, string>();
  const sosFactoryByCode = new Map<string, number>();
  for (const row of (sosProducts.data ?? []) as Array<{ product_code?: string | null; normalized_product_name?: string | null; factory_price?: unknown }>) {
    const code = String(row.product_code ?? "").trim().toUpperCase();
    const key = lowerTrim(row.normalized_product_name);
    if (key && !sosProductByNorm.has(key)) sosProductByNorm.set(key, code);
    if (code && !sosFactoryByCode.has(code)) sosFactoryByCode.set(code, Number(row.factory_price) || 0);
  }

  const products: RoiExplainProduct[] = [];
  for (const row of productRows) {
    const code = String(row.product_code ?? "").trim().toUpperCase();
    const name = String(row.product_name ?? "").trim();
    const normalized = String(row.normalized_name ?? row.product_name ?? "").trim();
    if (!reveal && isRestrictedMarketingProduct(code, normalized, restrictedNames)) continue; // mask confidential
    const sosProductCode = sosProductByNorm.get(lowerTrim(normalized)) ?? null;
    products.push({ code, name: name || code, matchedToSos: Boolean(sosProductCode), sosProductCode });
  }

  // 3) Distributor rollup / family used for this request's target pharmacies.
  const pharmacyLinks = await supabase
    .from("marketing_request_pharmacies")
    .select("distributor_code_id")
    .eq("request_id", cleanId);
  if (pharmacyLinks.error) throw pharmacyLinks.error;
  const codeIds = uniqueStrings(((pharmacyLinks.data ?? []) as Array<{ distributor_code_id: string }>).map((row) => row.distributor_code_id));
  let codeRows: Array<{ distributor_id: number | string; normalized_pharmacy_code?: string | null }> = [];
  if (codeIds.length > 0) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("distributor_id, normalized_pharmacy_code")
      .in("id", codeIds);
    if (error) throw error;
    codeRows = (data ?? []) as typeof codeRows;
  }
  const targetCodes = uniqueStrings(codeRows.map((row) => row.normalized_pharmacy_code ?? null));
  const distributorIds = Array.from(new Set(codeRows.map((row) => Number(row.distributor_id)).filter((id) => Number.isFinite(id) && id > 0)));
  let distRows: Array<{ distributor_code?: string | null; normalized_name?: string | null }> = [];
  if (distributorIds.length > 0) {
    const { data, error } = await supabase
      .from("marketing_distributors")
      .select("distributor_code, normalized_name")
      .in("id", distributorIds);
    if (error) throw error;
    distRows = (data ?? []) as typeof distRows;
  }
  const distNameByNorm = new Map<string, string>();
  for (const row of distRows) {
    const key = lowerTrim(row.normalized_name);
    if (key) distNameByNorm.set(key, String(row.distributor_code ?? row.normalized_name ?? "").trim());
  }
  const normDistNames = uniqueStrings(distRows.map((row) => lowerTrim(row.normalized_name)));
  let rollupRows: Array<{ sos_distributor_code?: string | null; parent_distributor_code?: string | null; marketing_normalized_name?: string | null }> = [];
  if (normDistNames.length > 0) {
    const { data, error } = await supabase
      .from("marketing_roi_distributor_rollup")
      .select("sos_distributor_code, parent_distributor_code, marketing_normalized_name")
      .in("marketing_normalized_name", normDistNames);
    if (error) throw error;
    rollupRows = (data ?? []) as typeof rollupRows;
  }
  const familyByDistributor = new Map<string, RoiExplainDistributorFamily>();
  const rolledUpSosCodes = new Set<string>();
  for (const row of rollupRows) {
    const sos = String(row.sos_distributor_code ?? "").trim();
    if (sos) rolledUpSosCodes.add(sos);
    const marketingKey = lowerTrim(row.marketing_normalized_name);
    const family = familyByDistributor.get(marketingKey) ?? {
      marketingDistributor: distNameByNorm.get(marketingKey) ?? String(row.marketing_normalized_name ?? "").trim(),
      parentDistributorCode: String(row.parent_distributor_code ?? "").trim(),
      sosDistributorCodes: [],
    };
    if (sos && !family.sosDistributorCodes.includes(sos)) family.sosDistributorCodes.push(sos);
    familyByDistributor.set(marketingKey, family);
  }
  const distributorFamilies = Array.from(familyByDistributor.values());

  // 4) ROI window months + validated-vs-pending split against the latest validated SoS period.
  const salesDataAsOf = viewSales.salesDataAsOf;
  const windowStart = viewSales.context.payDate ? viewSales.context.payDate.slice(0, 7) : null;
  const months = Math.max(1, viewSales.context.roiDurationMonths || 1);
  const windowPeriods: string[] = [];
  if (windowStart && /^\d{4}-\d{2}$/.test(windowStart)) {
    for (let i = 0; i < months; i += 1) windowPeriods.push(monthAdd(windowStart, i));
  }
  const validatedPeriodsInWindow = windowPeriods.filter((period) => salesDataAsOf !== null && period <= salesDataAsOf);
  const pendingPeriodsInWindow = windowPeriods.filter((period) => salesDataAsOf === null || period > salesDataAsOf);

  // Validated batch ids — shared by the pharmacy-presence probe and the ledger id lookup.
  const validatedBatches = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("status", "validated");
  if (validatedBatches.error) throw validatedBatches.error;
  const validatedBatchIds = uniqueStrings(((validatedBatches.data ?? []) as Array<{ id: string }>).map((row) => row.id));

  const targetCodeSet = new Set(targetCodes);
  const targetProductCodes = new Set(
    products.filter((product) => product.matchedToSos && product.sosProductCode).map((product) => String(product.sosProductCode).toUpperCase()),
  );

  // 5) Pharmacy presence — do the target codes appear in validated SoS under the rolled-up
  //    distributors within the window? Filtered to the target codes so the scan stays small.
  const foundCodes = new Set<string>();
  if (targetCodes.length > 0 && rolledUpSosCodes.size > 0 && windowPeriods.length > 0 && validatedBatchIds.length > 0) {
    const presence = await supabase
      .from("source_of_sales_import_rows")
      .select("client_code")
      .in("distributor_code", Array.from(rolledUpSosCodes))
      .in("invoice_period", windowPeriods)
      .in("batch_id", validatedBatchIds)
      .eq("validation_state", "valid")
      .in("client_code", targetCodes);
    if (presence.error) throw presence.error;
    for (const row of (presence.data ?? []) as Array<{ client_code?: string | null }>) {
      const normalized = normalizePharmacyCode(row.client_code);
      if (normalized) foundCodes.add(normalized);
    }
  }

  const pharmacies: RoiExplainPharmacy[] = viewSales.context.pharmacies.map((pharmacy) => ({
    code: pharmacy.code,
    name: pharmacy.name,
    foundInSos: foundCodes.has(pharmacy.code),
  }));

  // 6) Ledger. The authoritative rows are the exact attribution from the view-sales RPC (which
  //    reconciles to actualValue) but that RPC does not expose the source row id. Replicate the
  //    SAME strict match with a bounded, read-only SELECT for THIS request only to recover
  //    source_of_sales_import_rows.id, and adopt it ONLY when its total reconciles to the RPC to
  //    the cent — otherwise keep the RPC rows (sosRowId null). This never changes the RPC.
  let ledger: RoiExplainLedgerRow[] = viewSales.rows.map((row, index) => ({
    ledgerKey: `${row.distributorCode}|${row.customerCode}|${row.productCode}|${row.invoicePeriod}|${index}`,
    sosRowId: null,
    distributorCode: row.distributorCode,
    clientCode: row.customerCode,
    productCode: row.productCode,
    invoicePeriod: row.invoicePeriod,
    qty: row.qty,
    valueCounted: row.value,
    matchReason: ROI_EXPLAIN_MATCH_REASON,
    confidence: "high",
  }));

  if (
    validatedBatchIds.length > 0 &&
    rolledUpSosCodes.size > 0 &&
    windowPeriods.length > 0 &&
    targetCodeSet.size > 0 &&
    targetProductCodes.size > 0
  ) {
    // Filtering by the target pharmacy codes bounds the scan to this request's rows (tiny). If it
    // ever hits the cap we treat it as unsafe (possibly truncated) and keep the RPC fallback.
    const LEDGER_ROW_CAP = 5000;
    const ledgerScan = await supabase
      .from("source_of_sales_import_rows")
      .select("id, distributor_code, client_code, product_code, invoice_period, qty, discount, is_direct, value")
      .in("distributor_code", Array.from(rolledUpSosCodes))
      .in("invoice_period", windowPeriods)
      .in("batch_id", validatedBatchIds)
      .eq("validation_state", "valid")
      .in("client_code", targetCodes)
      .limit(LEDGER_ROW_CAP + 1);
    if (ledgerScan.error) throw ledgerScan.error;
    const scanRows = (ledgerScan.data ?? []) as Array<{
      id: number | string;
      distributor_code?: string | null;
      client_code?: string | null;
      product_code?: string | null;
      invoice_period?: string | null;
      qty?: unknown;
      discount?: unknown;
      is_direct?: unknown;
      value?: unknown;
    }>;
    if (scanRows.length <= LEDGER_ROW_CAP) {
      const seenRowIds = new Set<string>();
      const rebuilt: RoiExplainLedgerRow[] = [];
      for (const row of scanRows) {
        const rowId = String(row.id ?? "");
        if (!rowId || seenRowIds.has(rowId)) continue;
        const normClient = normalizePharmacyCode(row.client_code);
        const upperProduct = String(row.product_code ?? "").trim().toUpperCase();
        // Re-apply the exact match precisely in TS (the `.in()` filters only bound the scan).
        if (!targetCodeSet.has(normClient) || !targetProductCodes.has(upperProduct)) continue;
        seenRowIds.add(rowId);
        const qty = Number(row.qty) || 0;
        const valueRaw = row.is_direct === true
          ? Number(row.value) || 0
          : qty * (1 - (Number(row.discount) || 0)) * (sosFactoryByCode.get(upperProduct) ?? 0);
        rebuilt.push({
          ledgerKey: rowId,
          sosRowId: Number(row.id),
          distributorCode: String(row.distributor_code ?? "").trim(),
          clientCode: normClient,
          productCode: upperProduct,
          invoicePeriod: String(row.invoice_period ?? "").trim(),
          qty,
          valueCounted: roundMarketingMoney(valueRaw),
          matchReason: ROI_EXPLAIN_MATCH_REASON,
          confidence: "high",
        });
      }
      const rebuiltTotal = roundMarketingMoney(rebuilt.reduce((sum, row) => sum + row.valueCounted, 0));
      if (rebuiltTotal === roundMarketingMoney(viewSales.actualValue)) {
        ledger = rebuilt.sort((left, right) => left.invoicePeriod.localeCompare(right.invoicePeriod) || left.productCode.localeCompare(right.productCode));
      }
    }
  }

  // 7) Diagnostic classification.
  const productsMatched = products.filter((product) => product.matchedToSos).length;
  const pharmaciesFound = pharmacies.filter((pharmacy) => pharmacy.foundInSos).length;
  const reason = classifyRoiExplainReason({
    actualValue: viewSales.actualValue,
    productsTargeted: products.length,
    productsMatched,
    pharmaciesFound,
    monthsCovered: validatedPeriodsInWindow.length,
    salesDataAsOf,
  });

  return {
    summary: {
      requestId: cleanId,
      requestCode: viewSales.context.requestCode,
      customerName: viewSales.context.customerName,
      payDate: viewSales.context.payDate,
      roiWindowLabel: viewSales.context.roiWindowLabel,
      requiredRoiValue: viewSales.context.requiredRoiValue,
      expectedRoiValue: viewSales.context.expectedRoiValue,
      actualSalesValue: viewSales.actualValue,
      actualCoverageRatio: viewSales.coverageRatio,
      salesDataAsOf,
    },
    targetSetup: {
      products,
      pharmacies,
      distributorFamilies,
      validatedPeriodsInWindow,
      pendingPeriodsInWindow,
    },
    ledger,
    diagnostic: {
      reason,
      pharmaciesTargeted: pharmacies.length,
      pharmaciesFound,
      pharmaciesMissing: pharmacies.length - pharmaciesFound,
      productsTargeted: products.length,
      productsMatched,
      productsUnmatched: products.length - productsMatched,
      monthsInWindow: windowPeriods.length,
      monthsCovered: validatedPeriodsInWindow.length,
      monthsPending: pendingPeriodsInWindow.length,
      hasAttributedSales: viewSales.actualValue > 0,
    },
    includedRestricted: reveal,
    generatedAtIso,
  };
}
