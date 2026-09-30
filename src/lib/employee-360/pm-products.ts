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

/**
 * Replace a PM's assignments (Super-Admin-only — the route enforces the role).
 *
 * 🔴 IT READS BOTH ERRORS. supabase-js RETURNS a failure in `error` rather than throwing it, so
 * until 2026-09-30 neither result was destructured: the route's own try/catch caught nothing and it
 * answered `{ok: true}` whatever happened. That is worse than a plain failure, because the delete
 * runs FIRST — a failed insert left the Product Manager with NO products while the screen said
 * saved, and the reads above are deliberately table-missing-safe, so Employee 360 then quietly
 * attributed his sales through the (usually empty) team roll-up with nothing to show anything had
 * gone wrong. It needed no schema change to fire: any constraint breach or transient error did it.
 *
 * The two steps are still not atomic — PostgREST has no transaction across them — so surfacing the
 * insert's error is the whole point: the admin is told the list was cleared and can re-save, instead
 * of believing it stuck. The route turns either throw into its existing 409.
 */
export async function setPmProductCodes(
  hrId: string,
  productCodes: string[],
  actorHrId: string,
  // The client is a parameter so a test can hand in a stub and drive the two failure branches. A
  // real database will not produce an error on demand, and those branches are the whole fix.
  db: ReturnType<typeof getSupabaseAdmin> = getSupabaseAdmin(),
): Promise<void> {
  const supabase = db;
  const codes = Array.from(new Set(productCodes.map((c) => String(c).trim()).filter(Boolean)));

  const { error: clearError } = await supabase.from("pm_product_assignments").delete().ilike("hr_id", hrId);
  if (clearError) {
    throw new Error(`Could not clear the previous product assignments, so nothing was changed: ${clearError.message}`);
  }

  if (codes.length === 0) return;

  const { error: insertError } = await supabase
    .from("pm_product_assignments")
    .insert(codes.map((product_code) => ({ hr_id: hrId, product_code, created_by: actorHrId })));
  if (insertError) {
    throw new Error(
      `The previous product assignments were cleared but the new ones could not be saved, so this `
        + `Product Manager currently has none — save them again. ${insertError.message}`,
    );
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

// sales_records has NO product code — only a SKU-level `product` name (which carries
// dosage/pack suffixes and typos) plus a SKU-agnostic `family`. The product master's
// `family` matches the sales_records families EXCEPT one spelling variant (master
// "Dopaminict" vs sales "Dopaminect"). So mapping assigned CODES -> families ->
// sales_records.family is the reliable "by product id" attribution: a PM owns a whole
// brand/family, and family avoids the SKU-name drift that made exact-name matching
// undercount (e.g. master "Royafloxacin" vs sales "Royafloxacin 500mg tab").
const FAMILY_SALES_ALIASES: Record<string, string[]> = {
  // masterFamily(lowercased) -> the family spelling(s) that appear in sales_records
  dopaminict: ["Dopaminect", "Dopaminict"],
};

/** Resolve assigned product codes to the sales_records `family` values they belong to. */
export async function resolvePmSalesFamilies(productCodes: string[]): Promise<string[]> {
  const codes = Array.from(new Set(productCodes.map((c) => String(c).trim()).filter(Boolean)));
  if (codes.length === 0) return [];
  try {
    const { data } = await getSupabaseAdmin()
      .from("source_of_sales_products")
      .select("family")
      .in("product_code", codes);
    const families = new Set<string>();
    for (const row of data ?? []) {
      const fam = String((row as Record<string, unknown>).family ?? "").trim();
      if (!fam || fam.toUpperCase() === "IGNORE") continue;
      const aliases = FAMILY_SALES_ALIASES[fam.toLowerCase()];
      if (aliases) aliases.forEach((a) => families.add(a));
      else families.add(fam);
    }
    return [...families];
  } catch {
    return [];
  }
}
