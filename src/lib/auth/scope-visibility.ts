/**
 * Scope & Visibility — per-user line and product overrides.
 *
 * line_scope_override:    which product lines this user can see in probation,
 *                         organogram, and vacancies (overrides role-default single line).
 * product_scope_override: which product codes restrict sales and marketing-request
 *                         visibility (null = use line scope, [] = sees nothing, [...] = those codes only).
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "./permissions";

export type UserScopeOverride = {
  loginId: string;
  hrId: string | null;
  fullName: string | null;
  role: string | null;
  lineNames: string[] | null;
  productCodes: string[] | null;
  salesScopeOverride: string | null;
};

type ScopeOverrideRow = {
  login_id: string;
  hr_id: string | null;
  role: string | null;
  line_scope_override: string[] | null;
  product_scope_override: string[] | null;
  sales_scope_override: string | null;
};

// ─── read ─────────────────────────────────────────────────────────────────────

export async function getUserLineScopeOverride(loginId: string): Promise<string[] | null> {
  if (!loginId) return null;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("line_scope_override")
    .eq("login_id", loginId)
    .maybeSingle();
  const raw = (data as { line_scope_override?: string[] | null } | null)?.line_scope_override;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

export async function getUserProductScopeOverride(loginId: string): Promise<string[] | null> {
  if (!loginId) return null;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("product_scope_override")
    .eq("login_id", loginId)
    .maybeSingle();
  const raw = (data as { product_scope_override?: string[] | null } | null)?.product_scope_override;
  return Array.isArray(raw) ? raw : null;
}

/**
 * Resolve which product lines the viewer is allowed to see for HR modules
 * (probation, organogram, vacancies). Returns null when the role uses its own
 * built-in rule (company-wide or self-only) rather than an explicit line list.
 */
export async function resolveViewerAllowedLines(ctx: AccessContext): Promise<string[] | null> {
  if (!ctx.loginId) return null;
  const override = await getUserLineScopeOverride(ctx.loginId);
  return override;
}

/**
 * Resolve which product codes restrict this viewer's sales and marketing-request
 * visibility. Null = use line-based scope. Empty array = sees nothing. Non-empty
 * = only those codes are visible.
 */
export async function resolveViewerAllowedProductCodes(ctx: AccessContext): Promise<string[] | null> {
  if (!ctx.loginId) return null;
  return getUserProductScopeOverride(ctx.loginId);
}

// ─── admin list ───────────────────────────────────────────────────────────────

export async function listUserScopeOverrides(): Promise<UserScopeOverride[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id, hr_id, role, line_scope_override, product_scope_override, sales_scope_override")
    .eq("is_active", true)
    .order("login_id", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as ScopeOverrideRow[];

  // Load names from employees table
  const hrIds = rows.map((r) => r.hr_id).filter(Boolean) as string[];
  const nameByHrId = new Map<string, string | null>();
  if (hrIds.length > 0) {
    const { data: empData } = await supabase
      .from("employees")
      .select("hr_id, full_name")
      .in("hr_id", hrIds);
    for (const row of (empData ?? []) as Array<{ hr_id: string; full_name: string | null }>) {
      if (row.hr_id) nameByHrId.set(row.hr_id.toUpperCase(), row.full_name ?? null);
    }
  }

  return rows.map((row) => ({
    loginId: row.login_id,
    hrId: row.hr_id ?? null,
    fullName: row.hr_id ? (nameByHrId.get(row.hr_id.toUpperCase()) ?? null) : null,
    role: row.role ?? null,
    lineNames: Array.isArray(row.line_scope_override) && row.line_scope_override.length > 0
      ? row.line_scope_override
      : null,
    productCodes: Array.isArray(row.product_scope_override)
      ? row.product_scope_override
      : null,
    salesScopeOverride: row.sales_scope_override ?? null,
  }));
}

// ─── write ────────────────────────────────────────────────────────────────────

export type UpdateUserScopeInput = {
  loginId: string;
  lineNames: string[] | null;
  productCodes: string[] | null;
  salesScopeOverride: string | null;
};

export async function updateUserScopeOverride(input: UpdateUserScopeInput): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("app_auth_users")
    .update({
      line_scope_override: input.lineNames && input.lineNames.length > 0 ? input.lineNames : null,
      product_scope_override: input.productCodes,
      sales_scope_override: input.salesScopeOverride ?? null,
    })
    .eq("login_id", input.loginId);

  if (error) throw error;
}
