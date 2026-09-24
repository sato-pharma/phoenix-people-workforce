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
// "Available in our database" is the same idea on both: the code is mapped into our territory
// (`mapped_area_code` is set). A code entered but never matched to our reference data reads
// `inDatabase: false` — exactly the "or no" the owner wants to see.
//
// Names never codes: the distributor's readable name is resolved from `source_of_sales_distributors`
// (direct orders) and `marketing_distributors` (marketing), with the short code kept beside it
// because the owner reads it too.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = 200;

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

  for (let index = 0; index < ids.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id, distributor_code, customer_code, mapped_area_code")
      .in("pharmacy_id", ids.slice(index, index + CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      pharmacy_id: string;
      distributor_code: string | null;
      customer_code: string | null;
      mapped_area_code: string | null;
    }>) {
      pushCode(byPharmacy, row.pharmacy_id, {
        distributorName: row.distributor_code ? names.get(row.distributor_code) ?? null : null,
        distributorCode: row.distributor_code ?? null,
        customerCode: row.customer_code ?? null,
        inDatabase: row.mapped_area_code !== null,
      });
    }
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

  for (let index = 0; index < ids.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select(
        "pharmacy_id, distributor_id, distributor_pharmacy_code, mapped_distributor_code, mapped_customer_code, mapped_area_code, active",
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
      mapped_area_code: string | null;
    }>) {
      const chosen = row.distributor_id !== null ? marketingById.get(Number(row.distributor_id)) : undefined;
      const distributorCode = row.mapped_distributor_code ?? chosen?.distributorCode ?? null;
      const distributorName =
        chosen?.displayName ??
        (distributorCode ? sosNames.get(distributorCode) ?? null : null) ??
        (row.mapped_distributor_code ? sosNames.get(row.mapped_distributor_code) ?? null : null);
      pushCode(byPharmacy, row.pharmacy_id, {
        distributorName,
        distributorCode,
        customerCode: row.mapped_customer_code ?? row.distributor_pharmacy_code ?? null,
        inDatabase: row.mapped_area_code !== null,
      });
    }
  }
  return byPharmacy;
}
