/**
 * Scope & Visibility — per-user line and product overrides.
 *
 * line_scope_override:    which product lines this user can see in probation,
 *                         organogram, and vacancies (overrides role-default single line).
 * product_scope_override: which product codes restrict sales and marketing-request
 *                         visibility (null = use line scope, [] = sees nothing, [...] = those codes only).
 *                         It is the same list as the person's Weekly Sales product scope: both screens
 *                         save through src/lib/sales/product-scope-list.ts, which writes the two together.
 */

import { cache } from "react";

import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "./permissions";

export type ProductOption = {
  code: string;
  name: string;
  line: string;
};

export type UserScopeOverride = {
  loginId: string;
  hrId: string | null;
  fullName: string | null;
  displayName: string | null;
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

type LoginScopeOverrideColumns = Pick<
  ScopeOverrideRow,
  "line_scope_override" | "product_scope_override" | "sales_scope_override"
>;

// ONE read of a login's three override columns per request. A Sales vs Target render asked
// app_auth_users for the same row three times, once per column (line, product, sales scope).
//
// 🔴 A FAILED READ THROWS (technical audit, 2026-10-23, F-15). It used to answer null, and null means
// "no override" — the role's own, wider rule. So a product-restricted viewer saw the whole line
// whenever this read failed. An access read that cannot be made refuses; it never widens.
export const loadLoginScopeOverrides = cache(async (loginId: string): Promise<LoginScopeOverrideColumns | null> => {
  if (!loginId) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("line_scope_override, product_scope_override, sales_scope_override")
    .eq("login_id", loginId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read this login's visibility scope, so nothing was shown: ${error.message}`);
  }
  return (data as LoginScopeOverrideColumns | null) ?? null;
});

export async function getUserLineScopeOverride(loginId: string): Promise<string[] | null> {
  if (!loginId) return null;
  const raw = (await loadLoginScopeOverrides(loginId))?.line_scope_override;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

export async function getUserProductScopeOverride(loginId: string): Promise<string[] | null> {
  if (!loginId) return null;
  const raw = (await loadLoginScopeOverrides(loginId))?.product_scope_override;
  return Array.isArray(raw) ? raw : null;
}

/** The raw persisted sales scope override, or null when unset or not a login. Throws when unreadable. */
export async function getUserSalesScopeOverrideRaw(loginId: string): Promise<string | null> {
  if (!loginId) return null;
  return (await loadLoginScopeOverrides(loginId))?.sales_scope_override ?? null;
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

// ─── products ─────────────────────────────────────────────────────────────────

export async function listProducts(): Promise<ProductOption[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("product_code, product_name, line")
    .order("line", { ascending: true })
    .order("product_code", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as { product_code: string; product_name: string; line: string };
    return { code: row.product_code, name: row.product_name, line: row.line };
  });
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
  const nicknameByHrId = new Map<string, string | null>();
  // PostgREST folds every .in() value into the request URL; batch since hrIds is every active
  // login-enabled user company-wide.
  for (let i = 0; i < hrIds.length; i += 100) {
    const batch = hrIds.slice(i, i + 100);
    const { data: empData } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname")
      .in("hr_id", batch);
    for (const row of (empData ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null }>) {
      if (row.hr_id) {
        const key = canonicalHrIdForDisplay(row.hr_id) ?? row.hr_id.toUpperCase();
        nameByHrId.set(key, row.full_name ?? null);
        nicknameByHrId.set(key, row.nickname ?? null);
      }
    }
  }

  return rows.map((row) => {
    const key = row.hr_id ? canonicalHrIdForDisplay(row.hr_id) ?? row.hr_id.toUpperCase() : null;
    const fullName = key ? nameByHrId.get(key) ?? null : null;
    return {
      loginId: row.login_id,
      hrId: row.hr_id ?? null,
      fullName,
      displayName: fullName ? resolveEmployeeDisplayName(fullName, key ? nicknameByHrId.get(key) ?? null : null, key) : null,
      role: row.role ?? null,
      lineNames: Array.isArray(row.line_scope_override) && row.line_scope_override.length > 0
        ? row.line_scope_override
        : null,
      productCodes: Array.isArray(row.product_scope_override)
        ? row.product_scope_override
        : null,
      salesScopeOverride: row.sales_scope_override ?? null,
    };
  });
}

// ─── write ────────────────────────────────────────────────────────────────────

export type UpdateUserScopeInput = {
  loginId: string;
  lineNames: string[] | null;
  productCodes: string[] | null;
  salesScopeOverride: string | null;
};

/**
 * Only `src/lib/sales/product-scope-list.ts` calls this: the products saved here are also the
 * person's Weekly Sales product list, and that module writes both.
 */
export async function updateUserScopeOverride(
  input: UpdateUserScopeInput,
  supabase: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<void> {
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
