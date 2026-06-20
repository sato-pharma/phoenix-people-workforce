// Write-importer for the historical ROI sheet. Turns the parsed/normalized sheet into real
// marketing_requests (+ customers, pharmacies, product lines, pharmacy links), idempotently.
//
// Locked rules (see roi-sheet-import.ts):
//   - System is source of truth: persists the system-computed ROI (catalog price x qty),
//     never the sheet's number. Divergences are recorded in the request notes for managers.
//   - Divergences never block: only structurally impossible rows (no code / unknown
//     requester) are skipped. dd/mm date typos are auto-corrected in the parser.
//   - Idempotent: re-running upserts by natural keys (customer_code, pharmacy_code,
//     request_code, and the child unique constraints), so it never duplicates.
//
// Defaults to dryRun=true — callers must opt in to writes.

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculateMarketingRoiPreview, roundMarketingMoney } from "@/lib/marketing-requests/roi";
import { normalizeMarketingLookupKey } from "@/lib/marketing-requests/reference-importer";
import {
  aliasProductLookupKey,
  mapSheetRequestType,
  mapSheetStatus,
  parseRoiSheetRows,
  resolveDistributorRegistryName,
  type RoiSheetPharmacyLine,
  type RoiSheetRawRow,
  type RoiSheetRequestLine,
} from "@/lib/marketing-requests/roi-sheet-import";

export type RoiWriteResult = {
  dryRun: boolean;
  totalLineItems: number;
  importable: number;
  skippedBlocked: number;
  requestsWritten: number;
  distinctCustomers: number;
  distinctPharmacies: number;
  productLinks: number;
  pharmacyLinks: number;
  pharmaciesSyntheticCode: number; // named pharmacies with no usable code -> code synthesized
  unlinkablePharmacies: string[]; // could NOT be linked (no distributor) — surfaced, never silently dropped
  errors: string[];
};

type CatalogEntry = { id: number; factoryPrice: number; line: string | null; name: string };

type Lookups = {
  productByCode: Map<string, CatalogEntry>;
  productByName: Map<string, CatalogEntry>;
  distributorIdByName: Map<string, number>;
  requestTypeIdByCode: Map<string, number>;
  employeeHrIds: Set<string>;
};

function isoDate(date: Date | null): string | null {
  if (!date) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Stable synthetic code for a contact (the sheet has no code for the doctor/hospital).
// Same contact -> same code, so re-runs upsert instead of duplicating.
function stableCustomerCode(normalizedName: string): string {
  return `ROI-C-${createHash("sha1").update(normalizedName).digest("hex").slice(0, 12).toUpperCase()}`;
}

// A pharmacy's stable identity. If the sheet gives a usable (alphanumeric) customer code we
// use it; otherwise the pharmacy is named but coded in Arabic/blank, so we synthesize a
// stable code from the name so it is still created and linked — never skipped.
function pharmacyIdentity(pharmacy: RoiSheetPharmacyLine): {
  pharmacyCode: string;
  normalizedCode: string;
  synthetic: boolean;
} | null {
  if (pharmacy.matchKey) {
    const raw = pharmacy.rawCustomerCode as string;
    // normalized_pharmacy_code must match the sales-side comparison exactly:
    // lower(btrim(collapse-whitespace)) WITHOUT stripping leading zeros (POS codes are
    // zero-padded like "0001569882"; stripping them breaks the actual-sales bridge).
    return {
      pharmacyCode: raw,
      normalizedCode: raw.replace(/\s+/g, " ").trim().toLowerCase(),
      synthetic: false,
    };
  }
  const name = pharmacy.customerName;
  if (!name) return null; // no code and no name -> not a pharmacy
  const synthetic = `ROI-P-${createHash("sha1").update(normalizeMarketingLookupKey(name)).digest("hex").slice(0, 12).toUpperCase()}`;
  return { pharmacyCode: synthetic, normalizedCode: synthetic.toLowerCase(), synthetic: true };
}

function classifyCustomerType(name: string | null): string {
  const text = (name ?? "").toLowerCase();
  if (/مستشف|hospital|مستوصف|دار الولاد|نيكو|nicu/.test(text)) return "hospital";
  if (/مركز|عياد|clinic|center/.test(text)) return "clinic";
  return "doctor";
}

async function loadLookups(supabase: SupabaseClient): Promise<Lookups> {
  const { data: products, error: productError } = await supabase
    .from("marketing_products")
    .select("id, product_name, normalized_name, factory_price, line");
  if (productError) throw productError;
  const productByName = new Map<string, CatalogEntry>();
  const byNormalized = new Map<string, CatalogEntry>();
  for (const product of products ?? []) {
    const entry: CatalogEntry = {
      id: Number((product as { id: unknown }).id),
      factoryPrice: Number((product as { factory_price: unknown }).factory_price ?? 0),
      line: ((product as { line: unknown }).line as string | null) ?? null,
      name: String((product as { product_name: unknown }).product_name ?? ""),
    };
    const normalized = String((product as { normalized_name: unknown }).normalized_name ?? "");
    if (normalized) {
      productByName.set(normalized, entry);
      byNormalized.set(normalized, entry);
    }
  }

  const { data: sosProducts, error: sosError } = await supabase
    .from("source_of_sales_products")
    .select("product_code, product_name");
  if (sosError) throw sosError;
  const productByCode = new Map<string, CatalogEntry>();
  for (const sos of sosProducts ?? []) {
    const code = String((sos as { product_code: unknown }).product_code ?? "").trim().toUpperCase();
    const name = normalizeMarketingLookupKey((sos as { product_name: unknown }).product_name);
    const marketing = byNormalized.get(name);
    if (code && marketing) productByCode.set(code, marketing);
  }

  const { data: distributors, error: distError } = await supabase
    .from("marketing_distributors")
    .select("id, normalized_name");
  if (distError) throw distError;
  const distributorIdByName = new Map<string, number>();
  for (const dist of distributors ?? []) {
    const name = String((dist as { normalized_name: unknown }).normalized_name ?? "");
    if (name) distributorIdByName.set(name, Number((dist as { id: unknown }).id));
  }

  const { data: types, error: typeError } = await supabase
    .from("marketing_request_types")
    .select("id, code");
  if (typeError) throw typeError;
  const requestTypeIdByCode = new Map<string, number>();
  for (const type of types ?? []) {
    requestTypeIdByCode.set(
      String((type as { code: unknown }).code ?? ""),
      Number((type as { id: unknown }).id),
    );
  }

  const { data: employees, error: empError } = await supabase.from("employees").select("hr_id");
  if (empError) throw empError;
  const employeeHrIds = new Set<string>();
  for (const emp of employees ?? []) {
    const hrId = String((emp as { hr_id: unknown }).hr_id ?? "").trim().toUpperCase();
    if (hrId) employeeHrIds.add(hrId);
  }

  return { productByCode, productByName, distributorIdByName, requestTypeIdByCode, employeeHrIds };
}

function resolveProduct(
  code: string | null,
  name: string | null,
  lookups: Lookups,
): CatalogEntry | undefined {
  const byCode = code ? lookups.productByCode.get(code.toUpperCase()) : undefined;
  if (byCode) return byCode;
  const key = aliasProductLookupKey(name ?? code);
  return key ? lookups.productByName.get(key) : undefined;
}

function buildNote(line: RoiSheetRequestLine, advisories: string[]): string {
  const parts: string[] = [];
  if (line.note) parts.push(line.note);
  const provenance = [`Imported from ROI sheet (original code ${line.requestCode ?? "?"})`];
  if (advisories.length) provenance.push(`Review: ${advisories.join("; ")}`);
  parts.push(`[${provenance.join(" — ")}]`);
  return parts.join("\n");
}

export async function importRoiSheetRequests(opts: {
  rows: RoiSheetRawRow[];
  supabase?: SupabaseClient;
  dryRun?: boolean;
  limit?: number;
  // When true, use each line's requestCode verbatim as the marketing request_code (the
  // caller already minted a unique code per request). Otherwise a `-NN` sequence is appended
  // because the legacy sheet shares one code across several requests.
  codeAsIs?: boolean;
}): Promise<RoiWriteResult> {
  const supabase = opts.supabase ?? getSupabaseAdmin();
  const dryRun = opts.dryRun ?? true;
  const lookups = await loadLookups(supabase);
  const lines = parseRoiSheetRows(opts.rows);

  // Assign a unique request_code per line-item (the sheet's code is shared across several).
  const seqByCode = new Map<string, number>();

  const result: RoiWriteResult = {
    dryRun,
    totalLineItems: lines.length,
    importable: 0,
    skippedBlocked: 0,
    requestsWritten: 0,
    distinctCustomers: 0,
    distinctPharmacies: 0,
    productLinks: 0,
    pharmacyLinks: 0,
    pharmaciesSyntheticCode: 0,
    unlinkablePharmacies: [],
    errors: [],
  };
  const customersSeen = new Set<string>();
  const pharmaciesSeen = new Set<string>();
  const syntheticPharmacyCodesSeen = new Set<string>();

  let processed = 0;
  for (const line of lines) {
    if (opts.limit !== undefined && processed >= opts.limit) break;

    const requesterHrId = line.hrId ? line.hrId.toUpperCase() : null;
    if (!line.requestCode || !requesterHrId || !lookups.employeeHrIds.has(requesterHrId)) {
      result.skippedBlocked += 1;
      continue;
    }
    if (line.estimatedCost === 0 && line.sheetRoi === 0 && line.products.length === 0) {
      result.skippedBlocked += 1; // junk/blank line
      continue;
    }
    processed += 1;
    result.importable += 1;

    const seq = (seqByCode.get(line.requestCode) ?? 0) + 1;
    seqByCode.set(line.requestCode, seq);
    const requestCode = opts.codeAsIs
      ? (line.requestCode as string)
      : `${line.requestCode}-${String(seq).padStart(2, "0")}`;

    // Resolve + aggregate products (sum duplicates of the same catalog product).
    const qtyByProduct = new Map<number, { entry: CatalogEntry; quantity: number }>();
    const unresolvedProducts: string[] = [];
    for (const product of line.products) {
      const entry = resolveProduct(product.sheetProductCode, product.sheetProductName, lookups);
      if (!entry) {
        const label = product.sheetProductName ?? product.sheetProductCode ?? "(blank)";
        if (!unresolvedProducts.includes(label)) unresolvedProducts.push(label);
        continue;
      }
      const existing = qtyByProduct.get(entry.id);
      if (existing) existing.quantity += product.quantity;
      else qtyByProduct.set(entry.id, { entry, quantity: product.quantity });
    }

    const roiPreview = calculateMarketingRoiPreview({
      estimatedCost: line.estimatedCost,
      products: [...qtyByProduct.values()].map((p) => ({
        productId: p.entry.id,
        productName: p.entry.name,
        factoryPrice: p.entry.factoryPrice,
        quantity: p.quantity,
      })),
    });

    // Advisory notes for managers (per policy: surface divergences, do not block).
    const advisories: string[] = [];
    const sheetRoi = roundMarketingMoney(line.sheetRoi);
    if (sheetRoi > 0 && qtyByProduct.size > 0) {
      const diff = Math.abs(roiPreview.expectedRoiValue - sheetRoi);
      if (diff > 2 && diff / sheetRoi > 0.005) {
        advisories.push(`sheet ROI ${sheetRoi} vs system ${roiPreview.expectedRoiValue}`);
      }
    }
    if (line.dateSwapApplied) advisories.push("dates dd/mm-corrected");
    if (line.payDate && line.requestDate && line.payDate.getTime() < line.requestDate.getTime()) {
      advisories.push("pay date before request date");
    }
    if (unresolvedProducts.length) advisories.push(`unrecognized product: ${unresolvedProducts.join(", ")}`);

    const customerName = line.contact ?? "(unspecified contact)";
    const customerNormalized = normalizeMarketingLookupKey(customerName) || requestCode.toLowerCase();
    const customerCode = stableCustomerCode(customerNormalized);
    customersSeen.add(customerCode);

    const requestDateIso = isoDate(line.requestDate) ?? isoDate(new Date());
    const status = mapSheetStatus(line.rawStatus);
    const requestTypeCode = mapSheetRequestType(line.rawRequestType);

    // Plan every pharmacy on the line — skip NOTHING. Real pharmacies (a usable code OR a
    // name) get an identity (synthesizing a code when needed) and their distributor is
    // resolved by Distributor_ID. A pharmacy we genuinely cannot link (no distributor) is
    // recorded in unlinkablePharmacies and surfaced — never silently dropped.
    const plannedPharmacies: Array<{
      identity: NonNullable<ReturnType<typeof pharmacyIdentity>>;
      distributorId: number;
      pharmacy: RoiSheetPharmacyLine;
    }> = [];
    for (const pharmacy of line.pharmacies) {
      const identity = pharmacyIdentity(pharmacy);
      if (!identity) continue; // blank cell: no code and no name -> not a pharmacy
      pharmaciesSeen.add(identity.normalizedCode);
      if (identity.synthetic && !syntheticPharmacyCodesSeen.has(identity.pharmacyCode)) {
        syntheticPharmacyCodesSeen.add(identity.pharmacyCode);
        result.pharmaciesSyntheticCode += 1;
      }
      const distName = resolveDistributorRegistryName(pharmacy.distributorCode, pharmacy.distributor);
      const distributorId = distName ? lookups.distributorIdByName.get(distName) : undefined;
      if (!distributorId) {
        result.unlinkablePharmacies.push(
          `${requestCode}: "${pharmacy.customerName ?? identity.pharmacyCode}" — distributor '${pharmacy.distributorCode ?? pharmacy.distributor ?? "none"}' not in registry`,
        );
        continue;
      }
      plannedPharmacies.push({ identity, distributorId, pharmacy });
    }

    if (dryRun) {
      result.requestsWritten += 1;
      result.productLinks += qtyByProduct.size;
      result.pharmacyLinks += plannedPharmacies.length;
      continue;
    }

    try {
      // 1) Customer (contact)
      const { data: customer, error: customerError } = await supabase
        .from("marketing_customers")
        .upsert(
          {
            customer_code: customerCode,
            customer_type: classifyCustomerType(customerName),
            display_name: customerName,
            normalized_name: customerNormalized,
          },
          { onConflict: "customer_code" },
        )
        .select("id")
        .single();
      if (customerError) throw customerError;
      const customerId = (customer as { id: string }).id;

      // 2) Request
      const { data: request, error: requestError } = await supabase
        .from("marketing_requests")
        .upsert(
          {
            request_code: requestCode,
            requester_hr_id: requesterHrId,
            // The request belongs to its requester, not the admin running the import —
            // stamp created/updated_by with the requester (matches the normal create flow).
            created_by_hr_id: requesterHrId,
            updated_by_hr_id: requesterHrId,
            customer_id: customerId,
            request_type_id: lookups.requestTypeIdByCode.get(requestTypeCode)
              ?? lookups.requestTypeIdByCode.get("other"),
            request_date: requestDateIso,
            pay_date: isoDate(line.payDate),
            roi_duration_months: line.durationMonths && line.durationMonths > 0
              ? Math.round(line.durationMonths)
              : 1,
            estimated_cost: line.estimatedCost,
            expected_roi_value: roiPreview.expectedRoiValue,
            roi_status: roiPreview.roiStatus,
            status,
            notes: buildNote(line, advisories),
            submitted_at: status === "draft" ? null : `${requestDateIso}T00:00:00Z`,
            approved_at: status === "approved" ? `${requestDateIso}T00:00:00Z` : null,
            rejected_at: status === "rejected" ? `${requestDateIso}T00:00:00Z` : null,
          },
          { onConflict: "request_code" },
        )
        .select("id")
        .single();
      if (requestError) throw requestError;
      const requestId = (request as { id: string }).id;
      result.requestsWritten += 1;

      // 3) Product lines
      if (qtyByProduct.size > 0) {
        // expected_value is a GENERATED column (forecast_quantity * factory_price_snapshot) —
        // the database computes it, so it must not be supplied here.
        const productRows = roiPreview.products.map((p) => ({
          request_id: requestId,
          product_id: Number(p.productId),
          product_name_snapshot: p.productName ?? "",
          factory_price_snapshot: p.factoryPrice,
          forecast_quantity: p.quantity,
          value_share: p.valueShare,
        }));
        const { error: productLinkError } = await supabase
          .from("marketing_request_products")
          .upsert(productRows, { onConflict: "request_id,product_id" });
        if (productLinkError) throw productLinkError;
        result.productLinks += productRows.length;
      }

      // 4) Pharmacies + distributor codes + request links (every planned pharmacy; none skipped)
      for (const planned of plannedPharmacies) {
        const { identity, distributorId, pharmacy } = planned;
        const { data: pharmacyRow, error: pharmacyError } = await supabase
          .from("marketing_pharmacies")
          .upsert(
            {
              pharmacy_code: identity.pharmacyCode,
              display_name: pharmacy.customerName ?? identity.pharmacyCode,
              normalized_name: normalizeMarketingLookupKey(pharmacy.customerName ?? identity.pharmacyCode),
            },
            { onConflict: "pharmacy_code" },
          )
          .select("id")
          .single();
        if (pharmacyError) throw pharmacyError;
        const pharmacyId = (pharmacyRow as { id: string }).id;

        const { data: codeRow, error: codeError } = await supabase
          .from("marketing_pharmacy_distributor_codes")
          .upsert(
            {
              pharmacy_id: pharmacyId,
              distributor_id: distributorId,
              distributor_pharmacy_code: identity.pharmacyCode,
              normalized_pharmacy_code: identity.normalizedCode,
              reference_status: "pending",
            },
            { onConflict: "pharmacy_id,distributor_id,normalized_pharmacy_code" },
          )
          .select("id")
          .single();
        if (codeError) throw codeError;
        const distributorCodeId = (codeRow as { id: string }).id;

        const { error: linkError } = await supabase
          .from("marketing_request_pharmacies")
          .upsert(
            {
              request_id: requestId,
              pharmacy_id: pharmacyId,
              distributor_code_id: distributorCodeId,
              tracking_status: "pending_validation",
            },
            { onConflict: "request_id,distributor_code_id" },
          );
        if (linkError) throw linkError;
        result.pharmacyLinks += 1;
      }
    } catch (error) {
      result.errors.push(`${requestCode}: ${(error as Error).message ?? String(error)}`);
    }
  }

  result.distinctCustomers = customersSeen.size;
  result.distinctPharmacies = pharmaciesSeen.size;
  return result;
}
