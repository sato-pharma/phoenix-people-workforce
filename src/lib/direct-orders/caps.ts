import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// UI-editable bonus & discount caps. Percentages (0–100) live in `direct_order_caps`
// (Super Admin edits; SFE Manager + CEO view). The '__GLOBAL__' row holds the defaults
// (seeded 25% / 25%); other rows are per-product overrides (e.g. Ivyronc bonus 30%).

export const DIRECT_ORDER_GLOBAL_CAP_KEY = "__GLOBAL__";
const DEFAULT_BONUS_CAP_PCT = 25;
const DEFAULT_DISCOUNT_CAP_PCT = 25;

export type DirectOrderCapRow = {
  productCode: string; // '__GLOBAL__' or a real product_code
  bonusCapPct: number | null;
  discountCapPct: number | null;
  updatedBy: string | null;
  updatedAt: string;
};

export type DirectOrderCaps = {
  globalBonusCapPct: number;
  globalDiscountCapPct: number;
  byProduct: Map<string, { bonusCapPct: number | null; discountCapPct: number | null }>;
};

function mapCapRow(row: Record<string, unknown>): DirectOrderCapRow {
  return {
    productCode: String(row.product_code),
    bonusCapPct: row.bonus_cap_pct == null ? null : Number(row.bonus_cap_pct),
    discountCapPct: row.discount_cap_pct == null ? null : Number(row.discount_cap_pct),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: String(row.updated_at ?? ""),
  };
}

async function loadCapRows(): Promise<DirectOrderCapRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_caps")
    .select("*")
    .order("product_code", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapCapRow);
}

export async function loadDirectOrderCaps(): Promise<DirectOrderCaps> {
  const rows = await loadCapRows();
  const byProduct = new Map<string, { bonusCapPct: number | null; discountCapPct: number | null }>();
  let globalBonus = DEFAULT_BONUS_CAP_PCT;
  let globalDiscount = DEFAULT_DISCOUNT_CAP_PCT;
  for (const row of rows) {
    if (row.productCode === DIRECT_ORDER_GLOBAL_CAP_KEY) {
      if (row.bonusCapPct != null) globalBonus = row.bonusCapPct;
      if (row.discountCapPct != null) globalDiscount = row.discountCapPct;
    } else {
      byProduct.set(row.productCode, { bonusCapPct: row.bonusCapPct, discountCapPct: row.discountCapPct });
    }
  }
  return { globalBonusCapPct: globalBonus, globalDiscountCapPct: globalDiscount, byProduct };
}

export function resolveBonusCapPct(caps: DirectOrderCaps, productCode: string | null | undefined): number {
  const override = productCode ? caps.byProduct.get(productCode)?.bonusCapPct : null;
  return override ?? caps.globalBonusCapPct;
}

export function resolveDiscountCapPct(caps: DirectOrderCaps, productCode: string | null | undefined): number {
  const override = productCode ? caps.byProduct.get(productCode)?.discountCapPct : null;
  return override ?? caps.globalDiscountCapPct;
}

// ── Admin CRUD ────────────────────────────────────────────────────────────────

const CAP_VIEW_ROLES = new Set(["Super Admin", "SFE Manager", "CEO"]);
/**
 * Exported so the /admin/direct-orders/caps PAGE can redirect an unauthorized caller instead of
 * letting listDirectOrderCaps throw into an error boundary (which rendered a crash screen rather
 * than a clean bounce). listDirectOrderCaps still enforces this itself — the page check is UX.
 */
export function canViewDirectOrderCaps(access: AccessContext): boolean {
  return access.scope === "system" || CAP_VIEW_ROLES.has(access.role);
}
function canViewCaps(access: AccessContext): boolean {
  return canViewDirectOrderCaps(access);
}
function isSuperAdmin(access: AccessContext): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

export async function listDirectOrderCaps(access: AccessContext): Promise<{ rows: DirectOrderCapRow[]; canEdit: boolean }> {
  if (!canViewCaps(access)) throw new Error("Forbidden: you are not allowed to view direct-order caps.");
  return { rows: await loadCapRows(), canEdit: isSuperAdmin(access) };
}

function clampPct(value: number | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

export async function upsertDirectOrderCap(
  access: AccessContext,
  input: { productCode: string; bonusCapPct: number | null; discountCapPct: number | null },
): Promise<void> {
  if (!isSuperAdmin(access)) throw new Error("Forbidden: only a System Admin can change caps.");
  const code = String(input.productCode ?? "").trim();
  if (!code) throw new Error("A product code (or __GLOBAL__) is required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("direct_order_caps").upsert(
    {
      product_code: code,
      bonus_cap_pct: clampPct(input.bonusCapPct),
      discount_cap_pct: clampPct(input.discountCapPct),
      updated_by: access.hrId ?? access.loginId ?? "unknown",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "product_code" },
  );
  if (error) throw error;
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `caps:${code}`,
    newValues: { bonusCapPct: clampPct(input.bonusCapPct), discountCapPct: clampPct(input.discountCapPct) },
    summary: `Direct-order caps updated for ${code} by ${access.hrId ?? "unknown"}.`,
  });
}

export async function deleteDirectOrderCap(access: AccessContext, productCode: string): Promise<void> {
  if (!isSuperAdmin(access)) throw new Error("Forbidden: only a System Admin can change caps.");
  if (productCode === DIRECT_ORDER_GLOBAL_CAP_KEY) throw new Error("The global cap cannot be deleted.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("direct_order_caps").delete().eq("product_code", productCode);
  if (error) throw error;
}
