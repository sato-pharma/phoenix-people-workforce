// Product-Manager product master — server-only.
//
// A PM/GPM owns PRODUCTS, not a team. This maps them (hr_id) to the product codes
// they own so Employee 360 can attribute their sales by product. All reads are
// table-missing-safe (return empty) so the app keeps working before the
// pm_product_assignments migration is applied — PM sales then simply fall back to
// the (usually empty) team roll-up until assignments exist.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type PmProductOption = { code: string; name: string; line: string | null };

/** All PM→product-code assignments, keyed by canonical HR_ID. */
export async function listPmProductAssignments(): Promise<Map<string, string[]>> {
  const byHr = new Map<string, string[]>();
  try {
    const { data } = await getSupabaseAdmin()
      .from("pm_product_assignments")
      .select("hr_id, product_code");
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      const key = canonicalHrIdKey(String(r.hr_id ?? ""));
      const code = String(r.product_code ?? "").trim();
      if (!key || !code) continue;
      byHr.set(key, [...(byHr.get(key) ?? []), code]);
    }
  } catch {
    // pm_product_assignments not migrated yet.
  }
  return byHr;
}

/** Product codes assigned to one PM/GPM. */
export async function getPmProductCodes(hrId: string): Promise<string[]> {
  if (!canonicalHrIdKey(hrId)) return [];
  try {
    const { data } = await getSupabaseAdmin()
      .from("pm_product_assignments")
      .select("product_code")
      .ilike("hr_id", hrId);
    return (data ?? [])
      .map((r) => String((r as Record<string, unknown>).product_code ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Replace a PM's assignments (Super-Admin-only — the route enforces the role). */
export async function setPmProductCodes(hrId: string, productCodes: string[], actorHrId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const codes = Array.from(new Set(productCodes.map((c) => String(c).trim()).filter(Boolean)));
  await supabase.from("pm_product_assignments").delete().ilike("hr_id", hrId);
  if (codes.length > 0) {
    await supabase
      .from("pm_product_assignments")
      .insert(codes.map((product_code) => ({ hr_id: hrId, product_code, created_by: actorHrId })));
  }
}

/** The full product catalog to assign from (SoS product master). */
export async function listPmProductOptions(): Promise<PmProductOption[]> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("source_of_sales_products")
      .select("product_code, product_name, line")
      .order("line", { ascending: true });
    return (data ?? [])
      .map((row) => {
        const r = row as Record<string, unknown>;
        return { code: String(r.product_code ?? "").trim(), name: String(r.product_name ?? "").trim(), line: (r.line as string) ?? null };
      })
      .filter((p) => p.code);
  } catch {
    return [];
  }
}

/** Resolve assigned product codes to the product NAMES sales_records is keyed by. */
export async function resolvePmProductNames(productCodes: string[]): Promise<string[]> {
  const codes = Array.from(new Set(productCodes.map((c) => String(c).trim()).filter(Boolean)));
  if (codes.length === 0) return [];
  try {
    const { data } = await getSupabaseAdmin()
      .from("source_of_sales_products")
      .select("product_name")
      .in("product_code", codes);
    return (data ?? [])
      .map((r) => String((r as Record<string, unknown>).product_name ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
