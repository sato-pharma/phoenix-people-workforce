import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { VerifiedCaptureDistributorCode } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Distributor codes for the Verified Captures gallery (owner ask, 2026-09-25): "show me PH code and
// DISTB and tell me available in our database or no".
//
// A captured pharmacy can carry one or more distributor codes — the pharmacy's own customer code at
// each distributor it buys from. Direct-order and marketing pharmacies keep these in two different
// tables, so there is one loader each, both returning the same shape keyed by pharmacy id:
//
//   • direct_order_pharmacy_distributor_codes — a resolved `distributor_code` (PS / IS / …) and the
//     `customer_code`; `mapped_area_code` is set once we place it in a sales area.
//   • marketing_pharmacy_distributor_codes    — the raw `distributor_pharmacy_code` a rep entered, a
//     `distributor_id` into `marketing_distributors`, and the reference resolution
//     (`mapped_distributor_code` / `mapped_customer_code` / `mapped_area_code`).
//
// "Available in our database" means the pharmacy's distributor customer code actually shows up in
// our MONTHLY-CLOSING SALES (owner ask, 2026-09-25: "make 'in our database' check monthly-closing
// sales, not territory mapping"). The earlier build read `mapped_area_code` — whether we had placed
// the code in a sales territory — which is a mapping fact, not a sales fact: a code can be mapped and
// have sold nothing, or have real sales the owner cares about. The check now mirrors Customer 360's
// own reader (`src/lib/customer-360/service.ts`): a `(distributor_code, client_code)` pair is "in our
// database" when it carries a non-zero row in `source_of_sales_channel_customer_rollup`, across every
// period. A code entered but never matched, or matched with no sales, reads `inDatabase: false` —
// exactly the "or no" the owner wants to see.
//
// Names never codes: the distributor's readable name is resolved from `source_of_sales_distributors`
// (direct orders) and `marketing_distributors` (marketing), with the short code kept beside it
// because the owner reads it too.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = 200;

/** Stable key for a distributor+customer code pair. */
function pairKey(distributorCode: string, customerCode: string): string {
  return `${distributorCode}\u0000${customerCode}`;
}

/**
 * The subset of the given code pairs that carry real monthly-closing sales.
 *
 * PostgREST applies two `.in()` filters independently, so the query over-fetches the cross-product
 * of the two code lists. That is harmless here because membership is decided by an EXACT pair match
 * in memory afterwards — we never sum across the over-fetch, which is the trap Customer 360 warns
 * about. A row counts only when it moved money or units (`value_all`/`units_all` non-zero); a bare
 * zero row is presence in a dataset, not a sale.
 */
async function loadSalesPairs(
  pairs: ReadonlyArray<{ distributorCode: string; customerCode: string }>,
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Set<string>> {
  const withSales = new Set<string>();
  const wanted = new Set(pairs.map((pair) => pairKey(pair.distributorCode, pair.customerCode)));
  if (wanted.size === 0) return withSales;

  const distributorCodes = [...new Set(pairs.map((pair) => pair.distributorCode).filter(Boolean))];
  const customerCodes = [...new Set(pairs.map((pair) => pair.customerCode).filter(Boolean))];
  if (distributorCodes.length === 0 || customerCodes.length === 0) return withSales;

  for (let di = 0; di < distributorCodes.length; di += CHUNK) {
    const distChunk = distributorCodes.slice(di, di + CHUNK);
    for (let ci = 0; ci < customerCodes.length; ci += CHUNK) {
      const custChunk = customerCodes.slice(ci, ci + CHUNK);
      const { data, error } = await supabase
        .from("source_of_sales_channel_customer_rollup")
        .select("distributor_code, client_code, units_all, value_all")
        .in("distributor_code", distChunk)
        .in("client_code", custChunk);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{
        distributor_code: string | null;
        client_code: string | null;
        units_all: number | null;
        value_all: number | null;
      }>) {
        if (!row.distributor_code || !row.client_code) continue;
        const key = pairKey(row.distributor_code, row.client_code);
        if (!wanted.has(key)) continue; // exact pair only — discard cross-product noise
        const value = Number(row.value_all ?? 0);
        const units = Number(row.units_all ?? 0);
        if (value !== 0 || units !== 0) withSales.add(key);
      }
    }
  }
  return withSales;
}

/** distributor_code (e.g. "PS") → readable distributor name (e.g. "overseas"). */
async function loadSosDistributorNames(
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { data, error } = await supabase
    .from("source_of_sales_distributors")
    .select("distributor_code, distributor_name");
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ distributor_code: string | null; distributor_name: string | null }>) {
    if (row.distributor_code && row.distributor_name) names.set(row.distributor_code, row.distributor_name);
  }
  return names;
}

function pushCode(
  target: Map<string, VerifiedCaptureDistributorCode[]>,
  pharmacyId: string,
  code: VerifiedCaptureDistributorCode,
): void {
  const list = target.get(pharmacyId) ?? [];
  list.push(code);
  target.set(pharmacyId, list);
}

/** Distributor codes for a set of DIRECT-ORDER pharmacies, keyed by pharmacy id. */
export async function loadDirectOrderDistributorCodes(
  pharmacyIds: readonly string[],
  supabase = getSupabaseAdmin(),
): Promise<Map<string, VerifiedCaptureDistributorCode[]>> {
  const byPharmacy = new Map<string, VerifiedCaptureDistributorCode[]>();
  const ids = [...new Set(pharmacyIds.filter(Boolean))];
  if (ids.length === 0) return byPharmacy;

  const names = await loadSosDistributorNames(supabase);

  // Buffer every code first, gather the pairs, ask sales once, then emit with the sales verdict.
  type Buffered = { pharmacyId: string; distributorCode: string | null; customerCode: string | null };
  const buffered: Buffered[] = [];
  for (let index = 0; index < ids.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id, distributor_code, customer_code")
      .in("pharmacy_id", ids.slice(index, index + CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      pharmacy_id: string;
      distributor_code: string | null;
      customer_code: string | null;
    }>) {
      buffered.push({
        pharmacyId: row.pharmacy_id,
        distributorCode: row.distributor_code ?? null,
        customerCode: row.customer_code ?? null,
      });
    }
  }

  const salesPairs = await loadSalesPairs(
    buffered
      .filter((row) => row.distributorCode && row.customerCode)
      .map((row) => ({ distributorCode: row.distributorCode as string, customerCode: row.customerCode as string })),
    supabase,
  );

  for (const row of buffered) {
    pushCode(byPharmacy, row.pharmacyId, {
      distributorName: row.distributorCode ? names.get(row.distributorCode) ?? null : null,
      distributorCode: row.distributorCode,
      customerCode: row.customerCode,
      inDatabase:
        row.distributorCode !== null &&
        row.customerCode !== null &&
        salesPairs.has(pairKey(row.distributorCode, row.customerCode)),
    });
  }
  return byPharmacy;
}

/** Distributor codes for a set of MARKETING pharmacies, keyed by pharmacy id. Active links only. */
export async function loadMarketingDistributorCodes(
  pharmacyIds: readonly string[],
  supabase = getSupabaseAdmin(),
): Promise<Map<string, VerifiedCaptureDistributorCode[]>> {
  const byPharmacy = new Map<string, VerifiedCaptureDistributorCode[]>();
  const ids = [...new Set(pharmacyIds.filter(Boolean))];
  if (ids.length === 0) return byPharmacy;

  // marketing_distributors gives the readable name for the distributor the rep actually chose; the
  // SoS names cover the resolved `mapped_distributor_code` when the rep's choice was reconciled.
  const [sosNames, marketingResult] = await Promise.all([
    loadSosDistributorNames(supabase),
    supabase.from("marketing_distributors").select("id, distributor_code, display_name"),
  ]);
  if (marketingResult.error) throw marketingResult.error;
  const marketingById = new Map<
    number,
    { distributorCode: string | null; displayName: string | null }
  >();
  for (const row of (marketingResult.data ?? []) as Array<{
    id: number;
    distributor_code: string | null;
    display_name: string | null;
  }>) {
    marketingById.set(Number(row.id), { distributorCode: row.distributor_code, displayName: row.display_name });
  }

  // Buffer first so sales can be asked once. The DISPLAYED codes fall back to the rep's own entry,
  // but the SALES check keys strictly on the resolved reference (`mapped_distributor_code` /
  // `mapped_customer_code`) — that is what `source_of_sales_channel_customer_rollup` is keyed on, so
  // an unresolved link cannot match a sale and correctly reads "not in our database".
  type Buffered = {
    pharmacyId: string;
    distributorName: string | null;
    distributorCode: string | null;
    customerCode: string | null;
    mappedDistributorCode: string | null;
    mappedCustomerCode: string | null;
  };
  const buffered: Buffered[] = [];
  for (let index = 0; index < ids.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select(
        "pharmacy_id, distributor_id, distributor_pharmacy_code, mapped_distributor_code, mapped_customer_code, active",
      )
      .in("pharmacy_id", ids.slice(index, index + CHUNK))
      .neq("active", false);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      pharmacy_id: string;
      distributor_id: number | null;
      distributor_pharmacy_code: string | null;
      mapped_distributor_code: string | null;
      mapped_customer_code: string | null;
    }>) {
      const chosen = row.distributor_id !== null ? marketingById.get(Number(row.distributor_id)) : undefined;
      const distributorCode = row.mapped_distributor_code ?? chosen?.distributorCode ?? null;
      // No `?? null` inside the arms: it only turns a Map miss's `undefined` into `null` one
      // operand before the next `??`, which reads the same either way — and the native compiler
      // (TypeScript 7, the type gate since 2026-10-06) reports that shape as TS2871 "This
      // expression is always nullish", wrongly. Dropping it is behaviour-identical and quiet in
      // both compilers; the trailing `?? null` is what keeps the type `string | null`.
      const distributorName =
        chosen?.displayName ??
        (distributorCode ? sosNames.get(distributorCode) : null) ??
        (row.mapped_distributor_code ? sosNames.get(row.mapped_distributor_code) : null) ??
        null;
      buffered.push({
        pharmacyId: row.pharmacy_id,
        distributorName,
        distributorCode,
        customerCode: row.mapped_customer_code ?? row.distributor_pharmacy_code ?? null,
        mappedDistributorCode: row.mapped_distributor_code,
        mappedCustomerCode: row.mapped_customer_code,
      });
    }
  }

  const salesPairs = await loadSalesPairs(
    buffered
      .filter((row) => row.mappedDistributorCode && row.mappedCustomerCode)
      .map((row) => ({
        distributorCode: row.mappedDistributorCode as string,
        customerCode: row.mappedCustomerCode as string,
      })),
    supabase,
  );

  for (const row of buffered) {
    pushCode(byPharmacy, row.pharmacyId, {
      distributorName: row.distributorName,
      distributorCode: row.distributorCode,
      customerCode: row.customerCode,
      inDatabase:
        row.mappedDistributorCode !== null &&
        row.mappedCustomerCode !== null &&
        salesPairs.has(pairKey(row.mappedDistributorCode, row.mappedCustomerCode)),
    });
  }
  return byPharmacy;
}
